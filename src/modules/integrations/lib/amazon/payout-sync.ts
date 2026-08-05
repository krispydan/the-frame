/**
 * Amazon settlement → Xero posting orchestrator.
 *
 * Mirrors the Faire payout sync, which is the proven pattern in this repo for
 * a non-Shopify channel: open a sync run, load account mappings with a
 * helpful error when they are missing, check idempotency, post, record, sweep
 * the bank, throttle.
 *
 * Ordering is deliberate and matters for recovery. The `xero_payout_syncs`
 * row is written only AFTER a successful manual journal, so a failure part
 * way through leaves the settlement un-synced and the next run retries it
 * rather than skipping it. Every attempt — success or failure — writes a
 * `xero_journal_log` row, so a settlement that keeps failing is visible
 * without reading application logs.
 *
 * Xero forbids manual journals touching BANK accounts, hence the two-step:
 * the journal debits Receivables Holding (1100), then a BankTransaction
 * sweeps that into Amazon Clearing (1030).
 */

import { db, sqlite } from "@/lib/db";
import { inArray } from "drizzle-orm";
import { xeroAccountMappings, xeroTrackingMappings, SHARED_PLATFORM_KEY } from "@/modules/integrations/schema/xero";
import { postManualJournal, postBankTransactionReceive, postSettlementInvoice } from "@/modules/finance/lib/xero-client";
import { buildSettlementInvoice, amazonSettlementToComponents } from "@/modules/integrations/lib/xero/settlement-invoice-builder";
import { getPayoutRevenueModel } from "@/modules/integrations/lib/xero/payout-revenue-model";
import { notifyIntegrationFailure } from "@/modules/integrations/lib/slack/notifications";
import { summariseSettlement, type SettlementRowInput } from "./settlement-classify";
import { buildAmazonSettlementJournal, type AmazonXeroConfig } from "./settlement-journal";
import { amazonSettlementExternalId } from "./settlement-bridge";

export const AMAZON_PLATFORM = "amazon";

/** Xero allows roughly 60 requests/minute and we make two calls per settlement. */
const THROTTLE_MS = 1100;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Resolve Amazon account mappings, platform-specific winning over `_shared`.
 *
 * Throws with the exact missing categories rather than a generic failure —
 * "add these under Settings → Integrations → Xero" is actionable; "config
 * error" is not.
 */
export async function loadAmazonXeroConfig(): Promise<AmazonXeroConfig> {
  const rows = await db
    .select()
    .from(xeroAccountMappings)
    .where(inArray(xeroAccountMappings.sourcePlatform, [AMAZON_PLATFORM, SHARED_PLATFORM_KEY]));

  const byCategory = new Map<string, string>();
  for (const r of rows) {
    if (!r.xeroAccountCode) continue;
    if (r.sourcePlatform === AMAZON_PLATFORM || !byCategory.has(r.category)) {
      byCategory.set(r.category, r.xeroAccountCode);
    }
  }

  const required = [
    ["sales", "sales"],
    ["discounts", "discounts"],
    ["refunds", "refunds"],
    ["fees", "commission"],
    ["fba_fulfillment", "fbaFulfillment"],
    ["fba_storage", "fbaStorage"],
    ["subscription", "subscription"],
    ["inbound_freight", "inboundFreight"],
    ["outbound_shipping", "outboundShipping"],
    ["unclassified", "unclassified"],
    ["clearing", "clearing"],
    ["shipping", "shippingIncome"],
  ] as const;

  const cfg: Partial<AmazonXeroConfig> = {};
  const missing: string[] = [];
  for (const [category, field] of required) {
    const code = byCategory.get(category);
    if (!code) missing.push(category);
    else (cfg as Record<string, unknown>)[field] = code;
  }

  cfg.deferredRevenue = byCategory.get("deferred_revenue") ?? null;
  cfg.receivablesHolding = byCategory.get("receivables_holding") ?? null;

  if (missing.length) {
    throw new Error(
      `Amazon settlement sync needs Xero account mappings for: ${missing.join(", ")}. ` +
      `Add them under Settings → Integrations → Xero (the "Apply suggested defaults" button fills in the recommended accounts).`,
    );
  }

  const [tracking] = await db
    .select()
    .from(xeroTrackingMappings)
    .where(inArray(xeroTrackingMappings.sourcePlatform, [AMAZON_PLATFORM]));

  if (tracking?.trackingOptionId) {
    // Xero resolves tracking by Name + Option pair, not ID — omitting Name
    // silently drops the tracking without erroring.
    cfg.tracking = [{
      TrackingCategoryID: tracking.trackingCategoryId,
      Name: tracking.trackingCategoryName ?? undefined,
      Option: tracking.trackingOptionName ?? "",
    }];
  }

  return cfg as AmazonXeroConfig;
}

export interface PostResult {
  settlementId: string;
  status: "posted" | "skipped" | "failed";
  manualJournalId?: string;
  bankTransactionId?: string;
  net?: number;
  warnings: string[];
  error?: string;
}

export interface SyncSummary {
  considered: number;
  posted: number;
  skipped: number;
  failed: number;
  results: PostResult[];
  /** Set when the run could not start at all (e.g. missing mappings). */
  fatalError?: string;
}

interface StoredSettlementRow {
  settlement_id: string;
  transaction_type: string | null;
  amount_type: string | null;
  amount_description: string | null;
  amount: number;
  settlement_end_date: string | null;
  deposit_date: string | null;
}

/**
 * Post closed, un-posted Amazon settlements to Xero.
 *
 * `dryRun` builds and validates every journal without contacting Xero — the
 * right way to eyeball a first settlement. `status: "DRAFT"` posts to Xero
 * but leaves the journal unapproved, which is the recommended first live run.
 */
export async function syncAmazonSettlementsToXero(
  opts: {
    dryRun?: boolean;
    status?: "POSTED" | "DRAFT";
    settlementIds?: string[];
    limit?: number;
  } = {},
): Promise<SyncSummary> {
  const summary: SyncSummary = { considered: 0, posted: 0, skipped: 0, failed: 0, results: [] };

  let config: AmazonXeroConfig;
  try {
    config = await loadAmazonXeroConfig();
  } catch (e) {
    summary.fatalError = (e as Error).message;
    try {
      await notifyIntegrationFailure({
        service: "Amazon — Xero settlement sync",
        detail: summary.fatalError,
        fixUrl: "https://theframe.getjaxy.com/settings/integrations/xero",
      });
    } catch { /* alerting is best-effort */ }
    return summary;
  }

  const model = await getPayoutRevenueModel();

  // The deferred model needs the two accrual accounts; the invoice model does
  // not touch them. Checking here keeps the failure specific to the model
  // actually in use rather than demanding mappings that will never be read.
  if (model === "deferred" && (!config.deferredRevenue || !config.receivablesHolding)) {
    summary.fatalError =
      "payout_revenue_model is `deferred`, which needs `deferred_revenue` and `receivables_holding` account mappings.";
    return summary;
  }

  // Candidate settlements: bridged, closed, and not already posted.
  const where = opts.settlementIds?.length
    ? `AND REPLACE(external_id, 'amazon_settlement_', '') IN (${opts.settlementIds.map(() => "?").join(",")})`
    : "";
  const candidates = sqlite.prepare(`
    SELECT REPLACE(external_id, 'amazon_settlement_', '') AS settlementId,
           period_end AS periodEnd, net_amount AS net, received_at AS receivedAt
    FROM settlements
    WHERE channel = 'amazon' AND xero_transaction_id IS NULL ${where}
    ORDER BY IFNULL(period_end, period_start) ASC
    ${opts.limit ? `LIMIT ${Math.max(1, Math.trunc(opts.limit))}` : ""}
  `).all(...(opts.settlementIds ?? [])) as Array<{
    settlementId: string; periodEnd: string | null; net: number; receivedAt: string | null;
  }>;

  summary.considered = candidates.length;

  for (const candidate of candidates) {
    const result = await postOne(candidate, config, model, opts);
    summary.results.push(result);
    if (result.status === "posted") summary.posted++;
    else if (result.status === "skipped") summary.skipped++;
    else summary.failed++;

    if (!opts.dryRun && result.status === "posted") await sleep(THROTTLE_MS);
  }

  return summary;
}

async function postOne(
  candidate: { settlementId: string; periodEnd: string | null; net: number },
  config: AmazonXeroConfig,
  model: "deferred" | "invoice",
  opts: { dryRun?: boolean; status?: "POSTED" | "DRAFT" },
): Promise<PostResult> {
  const { settlementId } = candidate;

  // Idempotency guard. Checked before any Xero call so a re-run after a
  // partial failure cannot double-post.
  const alreadySynced = sqlite.prepare(
    "SELECT id FROM xero_payout_syncs WHERE source_platform = ? AND source_payout_id = ? LIMIT 1",
  ).get(AMAZON_PLATFORM, settlementId) as { id: string } | undefined;
  if (alreadySynced) {
    return { settlementId, status: "skipped", warnings: ["Already posted to Xero."] };
  }

  const rows = sqlite.prepare(`
    SELECT settlement_id, transaction_type, amount_type, amount_description, amount,
           settlement_end_date, deposit_date
    FROM amazon_settlement_rows WHERE settlement_id = ?
  `).all(settlementId) as StoredSettlementRow[];

  if (rows.length === 0) {
    return { settlementId, status: "failed", warnings: [], error: "No archived settlement rows found." };
  }

  const inputs: SettlementRowInput[] = rows.map((r) => ({
    transactionType: r.transaction_type,
    amountType: r.amount_type,
    amountDescription: r.amount_description,
    amount: r.amount,
  }));
  const settlementSummary = summariseSettlement(settlementId, inputs);

  const date = candidate.periodEnd
    ?? rows.find((r) => r.settlement_end_date)?.settlement_end_date
    ?? new Date().toISOString().slice(0, 10);

  // Settlement-date model: one ACCREC invoice whose total equals the deposit,
  // so the bank statement line matches 1:1 and no accrual accounts are touched.
  if (model === "invoice") {
    return postAsInvoice(settlementId, settlementSummary, config, date.slice(0, 10), opts);
  }

  const built = buildAmazonSettlementJournal({
    summary: settlementSummary,
    config,
    date: date.slice(0, 10),
    model,
    status: opts.status ?? "POSTED",
  });

  if (!built.ok) {
    logJournalAttempt(settlementId, "failed", null, settlementSummary.net, built.error);
    return { settlementId, status: "failed", warnings: [], error: built.error };
  }

  if (opts.dryRun) {
    return {
      settlementId, status: "skipped", net: built.netDeposit,
      warnings: ["Dry run — journal built and balanced, nothing posted.", ...built.warnings],
    };
  }

  // The builder returns a typed JournalLine[]; the client takes the looser
  // Record<string, unknown>[] that Xero's API shape requires.
  const journal = await postManualJournal({
    ...built.payload,
    JournalLines: built.payload.JournalLines as unknown as Array<Record<string, unknown>>,
  });
  if (!journal.success) {
    // No xero_payout_syncs row is written, so the next run retries.
    logJournalAttempt(settlementId, "failed", null, built.netDeposit, journal.error);
    return { settlementId, status: "failed", warnings: built.warnings, error: journal.error };
  }

  // Record the sync BEFORE the bank sweep: the journal is the part that must
  // never double-post. A failed sweep is recoverable by hand; a duplicated
  // journal is not.
  sqlite.prepare(`
    INSERT INTO xero_payout_syncs (id, source_platform, source_payout_id, amount, currency, paid_at, xero_object_type, xero_object_id, synced_at)
    VALUES (?, ?, ?, ?, 'USD', ?, 'manual_journal', ?, datetime('now'))
  `).run(crypto.randomUUID(), AMAZON_PLATFORM, settlementId, built.netDeposit, date.slice(0, 10), journal.manualJournalId);

  logJournalAttempt(settlementId, "success", journal.manualJournalId, built.netDeposit, null);

  sqlite.prepare(
    "UPDATE settlements SET xero_transaction_id = ?, xero_synced_at = datetime('now'), status = 'synced_to_xero' WHERE external_id = ?",
  ).run(journal.manualJournalId, amazonSettlementExternalId(settlementId));

  // Bank sweep. Skipped for a negative settlement, where Amazon charges the
  // card rather than depositing — that needs a payment, not a receipt.
  let bankTransactionId: string | undefined;
  const warnings = [...built.warnings];

  if (built.netDeposit > 0.005) {
    const sweep = await postBankTransactionReceive({
      bankAccountCode: config.clearing,
      contraAccountCode: config.receivablesHolding as string,
      amount: built.netDeposit,
      date: date.slice(0, 10),
      reference: `amazon_settlement_${settlementId}`,
      description: `Amazon settlement ${settlementId}`,
      contactName: "Amazon",
      tracking: config.tracking,
    });
    if (sweep.success) {
      bankTransactionId = sweep.bankTransactionId;
      logJournalAttempt(settlementId, "success", sweep.bankTransactionId, built.netDeposit, null, "bank_transaction");
    } else {
      warnings.push(
        `Journal posted, but the bank sweep failed: ${sweep.error}. ` +
        `Receivables Holding is overstated by ${built.netDeposit.toFixed(2)} until it is cleared manually.`,
      );
      logJournalAttempt(settlementId, "failed", null, built.netDeposit, sweep.error, "bank_transaction");
    }
  } else if (built.netDeposit < -0.005) {
    warnings.push(
      `Settlement is net negative (${built.netDeposit.toFixed(2)}) — Amazon charged the card rather than depositing. ` +
      `No bank receipt was created; record the charge against Amazon Clearing manually.`,
    );
  }

  return {
    settlementId, status: "posted", manualJournalId: journal.manualJournalId,
    bankTransactionId, net: built.netDeposit, warnings,
  };
}

/**
 * Post a settlement as an ACCREC invoice (the settlement-date model).
 *
 * Unlike the deferred path there is no bank sweep: the invoice IS the
 * receivable, and Xero reconciles it directly against the deposit. That is
 * the whole point of this model — one object per settlement, matched to one
 * bank line.
 *
 * A net-negative settlement is refused rather than posted. Amazon charged the
 * card instead of depositing, which is a credit note, not an invoice; posting
 * a negative invoice would misstate receivables and fail to match anything.
 */
async function postAsInvoice(
  settlementId: string,
  settlementSummary: ReturnType<typeof summariseSettlement>,
  config: AmazonXeroConfig,
  date: string,
  opts: { dryRun?: boolean; status?: "POSTED" | "DRAFT" },
): Promise<PostResult> {
  if (settlementSummary.net < 0) {
    const error =
      `Settlement is net negative (${settlementSummary.net.toFixed(2)}) — Amazon charged the card rather than ` +
      `depositing. That needs a credit note, not an invoice; record it manually against Amazon Clearing.`;
    logJournalAttempt(settlementId, "failed", null, settlementSummary.net, error, "invoice");
    return { settlementId, status: "failed", warnings: [], error };
  }

  const components = amazonSettlementToComponents(
    { settlementId, byCategory: settlementSummary.byCategory, net: settlementSummary.net },
    {
      sales: config.sales,
      shippingIncome: config.shippingIncome,
      discounts: config.discounts,
      refunds: config.refunds,
      commission: config.commission,
      fbaFulfillment: config.fbaFulfillment,
      fbaStorage: config.fbaStorage,
      subscription: config.subscription,
      inboundFreight: config.inboundFreight,
      outboundShipping: config.outboundShipping,
      unclassified: config.unclassified,
    },
  );

  const track = config.tracking?.[0];
  const built = buildSettlementInvoice({
    channel: AMAZON_PLATFORM,
    contactName: "Amazon",
    // Prefix already reserved in settlement-revenue.ts; it is the idempotency
    // key Xero itself enforces, on top of our xero_payout_syncs guard.
    invoiceNumber: `AMZN-${settlementId}`,
    reference: `Amazon settlement ${settlementId}`,
    date,
    netPayout: settlementSummary.net,
    components,
    tracking: track
      ? {
          trackingCategoryId: track.TrackingCategoryID ?? "",
          trackingCategoryName: track.Name ?? null,
          trackingOptionId: "",
          trackingOptionName: track.Option,
        }
      : null,
    status: opts.status === "DRAFT" ? "DRAFT" : "AUTHORISED",
  });

  if (!built.ok) {
    logJournalAttempt(settlementId, "failed", null, settlementSummary.net, built.error, "invoice");
    return { settlementId, status: "failed", warnings: [], error: built.error };
  }

  const warnings = [...built.warnings];
  if (settlementSummary.unclassified.length > 0) {
    warnings.push(`${settlementSummary.unclassified.length} settlement line(s) were unrecognised and booked to suspense.`);
  }
  if (Math.abs(settlementSummary.taxResidual) >= 0.01) {
    warnings.push(
      `Marketplace facilitator tax did not net to zero (residual ${settlementSummary.taxResidual}); ` +
      `the invoice excludes both tax legs, so that amount is currently unrecorded.`,
    );
  }

  if (opts.dryRun) {
    return {
      settlementId, status: "skipped", net: built.total,
      warnings: ["Dry run — invoice built and tied to the deposit, nothing posted.", ...warnings],
    };
  }

  const post = await postSettlementInvoice(built.payload as unknown as Record<string, unknown> & { InvoiceNumber: string });
  if (!post.success) {
    logJournalAttempt(settlementId, "failed", null, built.total, post.error ?? "unknown error", "invoice");
    return { settlementId, status: "failed", warnings, error: post.error };
  }
  if (post.existed) {
    warnings.push("An invoice with this number already existed in Xero; reused rather than duplicated.");
  }

  sqlite.prepare(`
    INSERT INTO xero_payout_syncs (id, source_platform, source_payout_id, amount, currency, paid_at, xero_object_type, xero_object_id, synced_at)
    VALUES (?, ?, ?, ?, 'USD', ?, 'invoice', ?, datetime('now'))
  `).run(crypto.randomUUID(), AMAZON_PLATFORM, settlementId, built.total, date, post.invoiceId ?? null);

  logJournalAttempt(settlementId, "success", post.invoiceId ?? null, built.total, null, "invoice");

  sqlite.prepare(
    "UPDATE settlements SET xero_transaction_id = ?, xero_synced_at = datetime('now'), status = 'synced_to_xero' WHERE external_id = ?",
  ).run(post.invoiceId ?? "existing", amazonSettlementExternalId(settlementId));

  return {
    settlementId, status: "posted",
    manualJournalId: post.invoiceId, net: built.total, warnings,
  };
}

function logJournalAttempt(
  settlementId: string,
  status: "success" | "failed",
  xeroObjectId: string | null,
  amount: number,
  error: string | null,
  objectType = "manual_journal",
): void {
  try {
    sqlite.prepare(`
      INSERT INTO xero_journal_log (id, source_platform, source_id, xero_object_type, xero_object_id, status, amount, currency, error_message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', ?, datetime('now'))
    `).run(crypto.randomUUID(), AMAZON_PLATFORM, settlementId, objectType, xeroObjectId, status, amount, error);
  } catch {
    // The audit log is best-effort; never let it fail the posting flow.
  }
}
