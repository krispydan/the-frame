/**
 * Faire payout sync — orchestrator for the per-Faire-order accrual flow.
 *
 * Faire doesn't expose a /payouts endpoint; the payout breakdown lives on
 * each order's `payout_costs` object once Faire initiates payout. This
 * file walks recent Faire orders, filters to those with
 * `payment_initiated_at` set, and posts one per-order Xero ManualJournal +
 * BankTransaction sweep — matching the architecture we use for Shopify.
 *
 * Per-order journal (revenue still defers under accrual, like Shopify):
 *   DR  Faire Payment Processing (5455)        $payment_fee
 *   DR  Faire Commission         (5450)        $commission
 *   DR  Receivables Holding      (1100, ASSET) $totalPayout
 *   CR  Deferred Revenue         (2050, LIAB)  $netOrderTotal
 *   CR  Faire Shipping Labels    (5460)        $shipping_reimbursement  ← contra-credit
 *
 * Then BankTransaction sweep:
 *   DR  Faire Payments Clearing  (1020, BANK)  $totalPayout
 *   CR  Receivables Holding      (1100, ASSET) $totalPayout
 *
 * Shipment-recognition cron (Stage 2) later moves Deferred Revenue → Sales
 * (4040 Sales - Faire Wholesale) when the order ships. To make that join
 * find the order, we also persist a synthetic `settlements` row +
 * `settlement_line_item` linking back to the local order.
 */

import { db, sqlite } from "@/lib/db";
import {
  xeroSyncRuns,
  xeroPayoutSyncs,
  xeroJournalLog,
  xeroAccountMappings,
  xeroTrackingMappings,
  SHARED_PLATFORM_KEY,
} from "@/modules/integrations/schema/xero";
import { settlements, settlementLineItems } from "@/modules/finance/schema";
import { orders } from "@/modules/orders/schema";
import { eq, and, inArray } from "drizzle-orm";
import { postManualJournal, postBankTransactionReceive, postSettlementInvoice } from "@/modules/finance/lib/xero-client";
import {
  listFaireOrdersPage,
  summarizeFairePayout,
  fairePayoutBalanceDelta,
  type FairePayoutSummary,
} from "./payouts";
import { getPayoutRevenueModel } from "@/modules/integrations/lib/xero/payout-revenue-model";
import { buildSettlementInvoice, fairePayoutToComponents } from "@/modules/integrations/lib/xero/settlement-invoice-builder";

const PLATFORM = "faire";
// Faire orders physically live on the Shopify wholesale store, but the
// payout / money flow is Faire's. Labeling these settlements as "faire"
// keeps the Finance > Settlements + Reconciliation views accurate (vs
// the old "shopify_wholesale" label which double-counted them in the
// wholesale recon period and made discrepancies wildly wrong).
const SETTLEMENT_CHANNEL = "faire" as const;
const HUMAN = "Faire";

export interface FairePayoutSyncResult {
  runId: string;
  scanned: number;
  paidEligible: number;
  posted: number;
  skipped: number;
  failed: number;
  errors: Array<{ orderId: string; message: string }>;
}

interface ChannelXeroConfig {
  paymentFeeAccount: string;
  commissionAccount: string;
  shippingLabelsAccount: string;
  /** Optional: 4060 Shipping Income. When configured, positive
   *  delta adjustments (buyer-paid shipping passthrough, Faire
   *  shipping overpayments) route here instead of 5460. */
  shippingIncomeAccount: string | null;
  /** Optional: 5900 Inventory Adjustments & Shrinkage. When
   *  configured, negative delta adjustments (damaged/missing
   *  items deducted from payout) route here instead of 5460. */
  inventoryAdjustmentsAccount: string | null;
  bankClearingAccount: string;     // 101x (BANK type)
  deferredRevenueAccount: string;  // 2050 (shared) — legacy deferred model
  salesAccount: string;            // 4040 Sales - Faire Wholesale (invoice model)
  receivablesHoldingAccount: string; // 1100 (shared)
  trackingCategoryId: string | null;
  trackingCategoryName: string | null;
  trackingOptionName: string | null;
}

/**
 * Walks Faire orders (paginated), processes any with `payment_initiated_at`
 * set that aren't yet in xero_payout_syncs. Idempotent.
 *
 * Bounded by `maxPages` so a single run can't OOM on a huge catalog. The
 * cron runs daily; new payouts trickle in slowly enough that one or two
 * pages of orders covers the gap.
 */
export async function syncFairePayouts(opts: { maxPages?: number } = {}): Promise<FairePayoutSyncResult> {
  const maxPages = opts.maxPages ?? 5;

  const [run] = await db.insert(xeroSyncRuns).values({
    kind: "faire_payouts",
    sourcePlatform: PLATFORM,
    status: "running",
    dateFrom: null,
    dateTo: null,
    totalPayouts: 0,
    successful: 0,
    failed: 0,
  }).returning();
  const runId = run.id;

  const result: FairePayoutSyncResult = {
    runId,
    scanned: 0,
    paidEligible: 0,
    posted: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  let cfg: ChannelXeroConfig;
  try {
    cfg = await loadFaireConfig();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "config load failed";
    result.errors.push({ orderId: "(setup)", message: msg });
    await closeRun(runId, result);
    return result;
  }

  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    let pageData: Awaited<ReturnType<typeof listFaireOrdersPage>>;
    try {
      pageData = await listFaireOrdersPage({ limit: 50, cursor });
    } catch (e) {
      result.errors.push({ orderId: "(list)", message: e instanceof Error ? e.message : "fetch failed" });
      break;
    }
    result.scanned += pageData.orders.length;

    for (const order of pageData.orders) {
      const summary = summarizeFairePayout(order);
      if (!summary) continue;                   // no payment_initiated_at yet — skip
      result.paidEligible++;

      // Idempotency: skip if we already posted this payout
      const existing = sqlite
        .prepare("SELECT id, amount FROM xero_payout_syncs WHERE source_platform = ? AND source_payout_id = ? LIMIT 1")
        .get(PLATFORM, summary.payoutKey) as { id: string; amount: number } | undefined;
      if (existing) {
        // ── Issue-credit detection ──
        // Faire retroactively rewrites payout_costs.total_payout when a
        // retailer issue report (under-shipment / damaged / missing) is
        // resolved, and claws the difference back as a SEPARATE bank debit.
        // Our posted entry keeps the original amount, so a drift between the
        // stored amount and the API's current amount means a bank line is
        // coming that needs manual coding (SOP §4b). Alert once per payout.
        const drift = Math.round((summary.totalPayout - existing.amount) * 100) / 100;
        if (Math.abs(drift) >= 0.01) {
          const alreadyAlerted = sqlite
            .prepare("SELECT 1 FROM xero_journal_log WHERE source_id = ? AND xero_object_type = 'issue_credit' LIMIT 1")
            .get(summary.payoutKey);
          if (!alreadyAlerted) {
            await db.insert(xeroJournalLog).values({
              syncRunId: runId,
              sourcePlatform: PLATFORM,
              sourceId: summary.payoutKey,
              xeroObjectType: "issue_credit",
              xeroObjectId: null,
              status: "detected",
              amount: drift,
              currency: summary.currency,
              payload: JSON.stringify({ kind: "faire_issue_credit", displayId: summary.displayId, originalPayout: existing.amount, currentPayout: summary.totalPayout, drift }),
            });
            try {
              const { notifyFaireIssueCredit } = await import("@/modules/integrations/lib/slack/notifications");
              await notifyFaireIssueCredit({
                displayId: summary.displayId,
                retailer: summary.retailerCompany ?? null,
                originalPayout: existing.amount,
                currentPayout: summary.totalPayout,
                delta: drift,
                currency: summary.currency,
              });
            } catch (e) {
              console.error("[faire-payout-sync] issue-credit Slack alert failed:", e);
            }
          }
        }
        result.skipped++; continue;
      }

      try {
        if (getPayoutRevenueModel() === "invoice") {
          await postFaireInvoice({ runId, summary, cfg });
        } else {
          await processFairePayout({ runId, summary, cfg });
        }
        result.posted++;
        // Xero rate-limits orgs to ~60 req/min. Each payout fires 2 calls
        // (ManualJournal + BankTransaction), so we throttle to ~30 payouts/min.
        // Sleep ~1.1s between payouts to stay comfortably under the cap.
        await new Promise((r) => setTimeout(r, 1100));
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unknown error";
        result.failed++;
        result.errors.push({ orderId: summary.displayId, message: msg });
        await db.insert(xeroJournalLog).values({
          syncRunId: runId,
          sourcePlatform: PLATFORM,
          sourceId: summary.payoutKey,
          xeroObjectType: "manual_journal",
          xeroObjectId: null,
          status: "failed",
          amount: summary.totalPayout,
          currency: summary.currency,
          payload: JSON.stringify({ summary }),
          errorMessage: msg,
        });
      }
    }

    if (!pageData.cursor) break;
    cursor = pageData.cursor;
  }

  await closeRun(runId, result);
  return result;
}

/** Post the per-order journal + bank sweep + local settlement bookkeeping. */
async function processFairePayout(opts: {
  runId: string;
  summary: FairePayoutSummary;
  cfg: ChannelXeroConfig;
}): Promise<void> {
  const { runId, summary, cfg } = opts;
  const balanceDelta = fairePayoutBalanceDelta(summary);

  const tracking = cfg.trackingCategoryId
    ? [{
        TrackingCategoryID: cfg.trackingCategoryId,
        Name: cfg.trackingCategoryName ?? undefined,
        Option: cfg.trackingOptionName ?? "",
      }]
    : undefined;

  // ── Manual journal lines ──
  // Positive LineAmount = debit, negative = credit
  const lines: Array<Record<string, unknown>> = [];

  if (summary.paymentFee > 0) {
    lines.push({
      LineAmount: summary.paymentFee,
      AccountCode: cfg.paymentFeeAccount,
      Description: `Faire payment processing fee — order ${summary.displayId}`,
      Tracking: tracking,
    });
  }
  if (summary.commission > 0) {
    lines.push({
      LineAmount: summary.commission,
      AccountCode: cfg.commissionAccount,
      Description: `Faire commission — order ${summary.displayId}`,
      Tracking: tracking,
    });
  }
  lines.push({
    LineAmount: summary.totalPayout,
    AccountCode: cfg.receivablesHoldingAccount,
    Description: `Receivables holding (net payout) — Faire order ${summary.displayId} — swept to bank via BankTransaction`,
    Tracking: tracking,
  });
  lines.push({
    LineAmount: -summary.netOrderTotal,
    AccountCode: cfg.deferredRevenueAccount,
    Description: `Deferred revenue (gross sales) — Faire order ${summary.displayId} (recognized at shipment)`,
    Tracking: tracking,
  });
  // NOTE: shippingReimbursement line removed 2026-06-22 after Xero
  // ValidationException on 56/224 payouts. Faire's totalPayout
  // empirically equals netOrderTotal - paymentFee - commission for
  // the majority of orders.
  //
  // BUT — 2026-06-22 follow-up audit: ~5% of orders have a totalPayout
  // that doesn't match ANY documented Faire formula. The actual wire
  // can be ±$10-60 different from what payout_costs implies, and the
  // missing amount isn't surfaced in any field of /external-api/v2/
  // orders/{id} — checked exhaustively (commission, shipping_subsidy,
  // damaged_and_missing_items, payout_protection_fee, net_tax,
  // brand_discounts, customer-paid shipping, all empty or accounted
  // for). Faire just sometimes pays a different number.
  //
  // We can't refuse to journal these — they represent real money. So:
  // compute the delta needed to make the journal balance to Faire's
  // ACTUAL wire, and post that delta to shippingLabelsAccount with a
  // clear description. The bookkeeper reviews it in Xero at month-end
  // and recategorizes if needed.
  //
  //   delta = totalPayout - (netOrderTotal - paymentFee - commission)
  //   if delta != 0:  add LineAmount = -delta to shippingLabelsAccount
  //
  // Positive delta (Faire paid MORE) → credit shippingLabelsAccount
  // (treats as shipping-subsidy income / reimbursement of label cost).
  // Negative delta (Faire paid LESS) → debit shippingLabelsAccount
  // (treats as additional fee taken by Faire). Both are reviewable.
  const expected = summary.netOrderTotal - summary.commission - summary.paymentFee;
  const delta = Math.round((summary.totalPayout - expected) * 100) / 100;
  if (Math.abs(delta) >= 0.01) {
    // Pick the best account based on direction:
    //   delta > 0  → income (buyer-paid shipping passthrough,
    //                 Faire shipping overpayment) → 4060 Shipping Income
    //   delta < 0  → expense/loss (damaged-items deduction,
    //                 hidden fee) → 5900 Inventory Adjustments
    //
    // Falls back to shippingLabelsAccount (5460) when the more
    // specific account isn't configured — preserves the original
    // delta-absorbing behavior so the journal still balances.
    let adjustmentAccount = cfg.shippingLabelsAccount;
    let labelHint = "shipping/labels (fallback)";
    if (delta > 0 && cfg.shippingIncomeAccount) {
      adjustmentAccount = cfg.shippingIncomeAccount;
      labelHint = "buyer-paid shipping or Faire overpayment";
    } else if (delta < 0 && cfg.inventoryAdjustmentsAccount) {
      adjustmentAccount = cfg.inventoryAdjustmentsAccount;
      labelHint = "damaged/missing items or Faire deduction";
    }
    lines.push({
      LineAmount: -delta, // positive delta → credit, negative → debit
      AccountCode: adjustmentAccount,
      Description: `Faire payout adjustment — order ${summary.displayId} (Faire paid ${delta > 0 ? "+" : ""}${delta.toFixed(2)} vs computed; likely ${labelHint}). Review at month-end.`,
      Tracking: tracking,
    });
  }

  const journal = {
    Narration: `Faire payout — order ${summary.displayId} | Net ${summary.currency} ${summary.totalPayout.toFixed(2)} | ${summary.paymentInitiatedAt.slice(0, 10)} | Generated by the-frame`,
    Date: summary.paymentInitiatedAt.slice(0, 10),
    Status: "POSTED" as const,
    JournalLines: lines,
  };

  const mj = await postManualJournal(journal);
  if (!mj.success) throw new Error(`ManualJournal failed: ${mj.error}`);

  await db.insert(xeroPayoutSyncs).values({
    sourcePlatform: PLATFORM,
    sourcePayoutId: summary.payoutKey,
    amount: summary.totalPayout,
    currency: summary.currency,
    paidAt: summary.paymentInitiatedAt.slice(0, 10),
    xeroObjectType: "manual_journal",
    xeroObjectId: mj.manualJournalId,
    syncRunId: runId,
  });

  await db.insert(xeroJournalLog).values({
    syncRunId: runId,
    sourcePlatform: PLATFORM,
    sourceId: summary.payoutKey,
    xeroObjectType: "manual_journal",
    xeroObjectId: mj.manualJournalId,
    status: "success",
    amount: summary.totalPayout,
    currency: summary.currency,
    payload: JSON.stringify({ kind: "deferred_revenue", summary, journal, balanceDelta }),
    response: JSON.stringify({ manualJournalId: mj.manualJournalId }),
  });

  // ── Bank sweep ──
  const bank = await postBankTransactionReceive({
    bankAccountCode: cfg.bankClearingAccount,
    contraAccountCode: cfg.receivablesHoldingAccount,
    amount: summary.totalPayout,
    date: summary.paymentInitiatedAt.slice(0, 10),
    reference: `faire_payout_${summary.payoutKey}`,
    description: `Faire payout — order ${summary.displayId} — net deposit (sweep from Receivables Holding)`,
    contactName: "Faire Payouts",
    tracking,
  });

  await db.insert(xeroJournalLog).values({
    syncRunId: runId,
    sourcePlatform: PLATFORM,
    sourceId: summary.payoutKey,
    xeroObjectType: "bank_transaction",
    xeroObjectId: bank.success ? bank.bankTransactionId : null,
    status: bank.success ? "success" : "failed",
    amount: summary.totalPayout,
    currency: summary.currency,
    payload: JSON.stringify({
      kind: "bank_receive",
      payoutKey: summary.payoutKey,
      bankAccountCode: cfg.bankClearingAccount,
      contraAccountCode: cfg.receivablesHoldingAccount,
      amount: summary.totalPayout,
    }),
    response: bank.success ? JSON.stringify({ bankTransactionId: bank.bankTransactionId }) : null,
    errorMessage: bank.success ? null : bank.error,
  });

  // ── Local settlement bookkeeping ──
  //
  // Stage 2 (shipment-revenue-recognition) joins through `settlements` +
  // `settlement_line_items` to know which orders qualify for revenue
  // recognition. Writing a synthetic settlement here lets Faire orders be
  // recognized at shipment exactly like Shopify-paid wholesale orders.

  const externalId = `faire_payout_${summary.payoutKey}`;
  const existingSettlement = sqlite
    .prepare("SELECT id FROM settlements WHERE external_id = ? LIMIT 1")
    .get(externalId) as { id: string } | undefined;

  if (!existingSettlement) {
    const settlementId = crypto.randomUUID();
    const periodEnd = summary.paymentInitiatedAt.slice(0, 10);
    const periodStart = new Date(periodEnd);
    periodStart.setUTCDate(periodStart.getUTCDate() - 7);
    db.insert(settlements).values({
      id: settlementId,
      channel: SETTLEMENT_CHANNEL,
      periodStart: periodStart.toISOString().slice(0, 10),
      periodEnd,
      grossAmount: summary.netOrderTotal,
      fees: summary.paymentFee + summary.commission,
      adjustments: summary.shippingReimbursement,  // shipping reimbursement counted as positive adjustment
      netAmount: summary.totalPayout,
      currency: summary.currency,
      externalId,
      status: "received",
      receivedAt: periodEnd,
    }).run();

    // Try to link to the local order by order_number = "#" + display_id
    const localOrder = db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.orderNumber, `#${summary.displayId}`))
      .get();

    db.insert(settlementLineItems).values({
      settlementId,
      orderId: localOrder?.id ?? null,
      type: "sale",
      description: `Faire order ${summary.displayId} (gross ${summary.currency} ${summary.netOrderTotal.toFixed(2)})`,
      amount: summary.netOrderTotal,
    }).run();

    if (summary.paymentFee > 0) {
      db.insert(settlementLineItems).values({
        settlementId,
        type: "fee",
        description: "Faire payment processing fee",
        amount: -summary.paymentFee,
      }).run();
    }
    if (summary.commission > 0) {
      db.insert(settlementLineItems).values({
        settlementId,
        type: "fee",
        description: "Faire commission",
        amount: -summary.commission,
      }).run();
    }
    if (summary.shippingReimbursement > 0) {
      db.insert(settlementLineItems).values({
        settlementId,
        type: "adjustment",
        description: "Shipping label reimbursement",
        amount: summary.shippingReimbursement,
      }).run();
    }
  }
}

/**
 * Settlement-date model: post ONE ACCREC invoice for a Faire payout (gross
 * order total to 4040, commission + processing as negative lines, documented
 * payout-delta plug), then write the synthetic settlement so COGS/reporting
 * stay consistent. No deferred journal, no bank sweep — the deposit reconciles
 * 1:1 against the invoice.
 */
async function postFaireInvoice(opts: {
  runId: string;
  summary: FairePayoutSummary;
  cfg: ChannelXeroConfig;
}): Promise<void> {
  const { runId, summary, cfg } = opts;
  if (summary.totalPayout <= 0) {
    throw new Error(`Net-negative Faire payout ${summary.displayId} (${summary.totalPayout.toFixed(2)}) — needs a manual credit note`);
  }

  const invoiceNumber = `FAIRE-${summary.payoutKey.replace(/^.*_/, "").toUpperCase()}`;
  const built = buildSettlementInvoice({
    channel: "faire",
    contactName: "Faire",
    invoiceNumber,
    reference: `Faire order ${summary.displayId} — ${summary.paymentInitiatedAt.slice(0, 10)}`,
    date: summary.paymentInitiatedAt.slice(0, 10),
    netPayout: summary.totalPayout,
    components: fairePayoutToComponents(
      { displayId: summary.displayId, netOrderTotal: summary.netOrderTotal, commission: summary.commission, paymentFee: summary.paymentFee, totalPayout: summary.totalPayout },
      { sales: cfg.salesAccount, commission: cfg.commissionAccount, paymentProcessing: cfg.paymentFeeAccount, shippingLabels: cfg.shippingLabelsAccount, shippingIncome: cfg.shippingIncomeAccount ?? undefined, inventoryAdjustments: cfg.inventoryAdjustmentsAccount ?? undefined },
    ),
    tracking: cfg.trackingCategoryId
      ? { trackingCategoryId: cfg.trackingCategoryId, trackingCategoryName: cfg.trackingCategoryName, trackingOptionId: "", trackingOptionName: cfg.trackingOptionName }
      : null,
  });
  if (!built.ok) throw new Error(built.error);

  const post = await postSettlementInvoice(built.payload);
  if (!post.success) throw new Error(`Invoice failed: ${post.error}`);

  await db.insert(xeroPayoutSyncs).values({
    sourcePlatform: PLATFORM,
    sourcePayoutId: summary.payoutKey,
    amount: summary.totalPayout,
    currency: summary.currency,
    paidAt: summary.paymentInitiatedAt.slice(0, 10),
    xeroObjectType: "invoice",
    xeroObjectId: post.invoiceId,
    syncRunId: runId,
  });
  await db.insert(xeroJournalLog).values({
    syncRunId: runId,
    sourcePlatform: PLATFORM,
    sourceId: summary.payoutKey,
    xeroObjectType: "invoice",
    xeroObjectId: post.invoiceId,
    status: "success",
    amount: summary.totalPayout,
    currency: summary.currency,
    payload: JSON.stringify({ kind: "settlement_invoice", summary, invoice: built.payload, warnings: built.warnings, existed: post.existed }),
    response: JSON.stringify({ invoiceId: post.invoiceId, existed: post.existed }),
  });

  ensureFaireSettlement(summary);
}

/** Write the synthetic settlement + line items for a Faire payout (idempotent
 *  by external_id). Shared by the deferred and invoice paths so the settlements
 *  table — which COGS + reporting read — stays complete. */
function ensureFaireSettlement(summary: FairePayoutSummary): void {
  const externalId = `faire_payout_${summary.payoutKey}`;
  const existing = sqlite.prepare("SELECT id FROM settlements WHERE external_id = ? LIMIT 1").get(externalId) as { id: string } | undefined;
  if (existing) return;

  const settlementId = crypto.randomUUID();
  const periodEnd = summary.paymentInitiatedAt.slice(0, 10);
  const periodStart = new Date(periodEnd);
  periodStart.setUTCDate(periodStart.getUTCDate() - 7);
  db.insert(settlements).values({
    id: settlementId,
    channel: SETTLEMENT_CHANNEL,
    periodStart: periodStart.toISOString().slice(0, 10),
    periodEnd,
    grossAmount: summary.netOrderTotal,
    fees: summary.paymentFee + summary.commission,
    adjustments: summary.shippingReimbursement,
    netAmount: summary.totalPayout,
    currency: summary.currency,
    externalId,
    status: "received",
    receivedAt: periodEnd,
  }).run();

  const localOrder = db.select({ id: orders.id }).from(orders).where(eq(orders.orderNumber, `#${summary.displayId}`)).get();
  db.insert(settlementLineItems).values({
    settlementId, orderId: localOrder?.id ?? null, type: "sale",
    description: `Faire order ${summary.displayId} (gross ${summary.currency} ${summary.netOrderTotal.toFixed(2)})`,
    amount: summary.netOrderTotal,
  }).run();
  if (summary.paymentFee > 0) db.insert(settlementLineItems).values({ settlementId, type: "fee", description: "Faire payment processing fee", amount: -summary.paymentFee }).run();
  if (summary.commission > 0) db.insert(settlementLineItems).values({ settlementId, type: "fee", description: "Faire commission", amount: -summary.commission }).run();
  if (summary.shippingReimbursement > 0) db.insert(settlementLineItems).values({ settlementId, type: "adjustment", description: "Shipping label reimbursement", amount: summary.shippingReimbursement }).run();
}

// ── Helpers ──

async function loadFaireConfig(): Promise<ChannelXeroConfig> {
  const rows = await db
    .select()
    .from(xeroAccountMappings)
    .where(inArray(xeroAccountMappings.sourcePlatform, [PLATFORM, SHARED_PLATFORM_KEY]));

  const byCategory = new Map<string, string>();
  for (const r of rows) {
    if (!r.xeroAccountCode) continue;
    // Platform-specific wins over shared
    if (r.sourcePlatform === PLATFORM || !byCategory.has(r.category)) {
      byCategory.set(r.category, r.xeroAccountCode);
    }
  }

  const required = [
    ["payment_processing", "paymentFeeAccount"],
    ["commission",         "commissionAccount"],
    ["shipping_labels",    "shippingLabelsAccount"],
    ["clearing",           "bankClearingAccount"],
    ["deferred_revenue",   "deferredRevenueAccount"],
    ["receivables_holding","receivablesHoldingAccount"],
  ] as const;

  // Optional mappings — when configured, the journal builder uses
  // these for better categorization of unexplained payout deltas.
  // Missing ones fall back to shippingLabelsAccount.
  const optional = [
    ["shipping_income",        "shippingIncomeAccount"],         // 4060
    ["inventory_adjustments",  "inventoryAdjustmentsAccount"],   // 5900
  ] as const;

  const cfg: Partial<ChannelXeroConfig> = {};
  const missing: string[] = [];
  for (const [cat, field] of required) {
    const code = byCategory.get(cat);
    if (!code) missing.push(cat);
    else cfg[field] = code;
  }
  for (const [cat, field] of optional) {
    const code = byCategory.get(cat);
    cfg[field] = code ?? null;
  }
  if (missing.length) {
    throw new Error(
      `Faire payout sync needs Xero account mappings for: ${missing.join(", ")}. ` +
      `Add them under Settings → Integrations → Xero.`,
    );
  }

  const [tk] = await db
    .select()
    .from(xeroTrackingMappings)
    .where(eq(xeroTrackingMappings.sourcePlatform, PLATFORM));

  return {
    paymentFeeAccount: cfg.paymentFeeAccount!,
    commissionAccount: cfg.commissionAccount!,
    shippingLabelsAccount: cfg.shippingLabelsAccount!,
    shippingIncomeAccount: cfg.shippingIncomeAccount ?? null,
    inventoryAdjustmentsAccount: cfg.inventoryAdjustmentsAccount ?? null,
    bankClearingAccount: cfg.bankClearingAccount!,
    deferredRevenueAccount: cfg.deferredRevenueAccount!,
    salesAccount: byCategory.get("sales") ?? "4040",
    receivablesHoldingAccount: cfg.receivablesHoldingAccount!,
    trackingCategoryId: tk?.trackingCategoryId ?? null,
    trackingCategoryName: tk?.trackingCategoryName ?? null,
    trackingOptionName: tk?.trackingOptionName ?? null,
  };
}

async function closeRun(runId: string, result: FairePayoutSyncResult): Promise<void> {
  await db.update(xeroSyncRuns).set({
    status: "completed",
    totalPayouts: result.paidEligible,
    successful: result.posted,
    failed: result.failed,
    completedAt: new Date().toISOString(),
  }).where(eq(xeroSyncRuns.id, runId));
  // silence unused
  void and;
  void HUMAN;
}
