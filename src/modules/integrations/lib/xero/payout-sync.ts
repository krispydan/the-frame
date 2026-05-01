/**
 * Shopify → Xero payout sync orchestrator.
 *
 * One run = one sync invocation across the connected Shopify shops.
 * Steps for each shop / payout:
 *   1. Fetch payouts in the date range
 *   2. For each payout: skip if already in xero_payout_syncs (idempotent)
 *   3. Fetch transactions, aggregate into PayoutSummary
 *   4. Build the manual journal payload using saved mappings + tracking
 *   5. POST to Xero
 *   6. Persist xero_payout_syncs row (so re-runs skip) + xero_journal_log entry
 *
 * Wraps the whole batch in a xero_sync_runs row so the UI can show progress.
 */

import { db, sqlite } from "@/lib/db";
import {
  xeroSyncRuns,
  xeroPayoutSyncs,
  xeroJournalLog,
  xeroJournalLogLines,
  xeroAccountMappings,
  xeroTrackingMappings,
  SHARED_PLATFORM_KEY,
} from "@/modules/integrations/schema/xero";
import { listInstalledShops } from "@/modules/integrations/lib/shopify/admin-api";
import { eq, and } from "drizzle-orm";
import { fetchShopifyPayouts, fetchShopifyPayoutTransactions } from "./shopify-payouts";
import { aggregatePayoutTransactions, type PayoutSummary } from "./payout-aggregator";
import { buildPayoutJournal, type AccountMapping, type TrackingMapping } from "./journal-builder";
import { aggregateCogsForPayout, type CogsAggregation } from "./cogs-aggregator";
import { buildCogsJournal, type CogsAccounts } from "./cogs-journal-builder";
import { postManualJournal } from "@/modules/finance/lib/xero-client";

export type SyncRunResult = {
  runId: string;
  totalPayouts: number;
  successful: number;
  skipped: number;
  failed: number;
  errors: Array<{ payoutId: number | null; platform: string | null; message: string }>;
};

export type SyncOpts = {
  /** ISO date YYYY-MM-DD. Default = 14 days ago. */
  dateFrom?: string;
  /** ISO date YYYY-MM-DD. Default = today. */
  dateTo?: string;
  /** Post journals as POSTED (default) or DRAFT for review. */
  status?: "POSTED" | "DRAFT";
  /** If true, ignore xero_payout_syncs and re-process every payout (DANGEROUS — creates duplicate journals in Xero). */
  force?: boolean;
};

const DEFAULT_WINDOW_DAYS = 14;

/** Map a connected Shopify shop's channel to a logical "base platform". */
function channelToBasePlatform(channel: string): "shopify_dtc" | "shopify_wholesale" | null {
  if (channel === "retail") return "shopify_dtc";
  if (channel === "wholesale") return "shopify_wholesale";
  return null;
}

export async function syncShopifyPayouts(opts: SyncOpts = {}): Promise<SyncRunResult> {
  const dateFrom = opts.dateFrom ?? new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400_000).toISOString().slice(0, 10);
  const dateTo = opts.dateTo ?? new Date().toISOString().slice(0, 10);
  const status = opts.status ?? "POSTED";
  const force = !!opts.force;

  // Open a sync run row
  const [run] = await db.insert(xeroSyncRuns).values({
    kind: "shopify_payouts",
    sourcePlatform: null,
    status: "running",
    dateFrom,
    dateTo,
    totalPayouts: 0,
    successful: 0,
    failed: 0,
  }).returning();
  const runId = run.id;

  const result: SyncRunResult = {
    runId,
    totalPayouts: 0,
    successful: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  try {
    const shops = await listInstalledShops();
    for (const shop of shops) {
      const platformBase = channelToBasePlatform(shop.channel);
      if (!platformBase) continue;  // skip non-payout channels (e.g. test stores)

      let payouts: Awaited<ReturnType<typeof fetchShopifyPayouts>> = [];
      try {
        payouts = await fetchShopifyPayouts(shop.channel, { dateMin: dateFrom, dateMax: dateTo, status: "paid" });
      } catch (e) {
        result.errors.push({
          payoutId: null,
          platform: shop.channel,
          message: `Failed to fetch payouts: ${e instanceof Error ? e.message : "Unknown"}`,
        });
        continue;
      }

      for (const payout of payouts) {
        result.totalPayouts++;

        // Idempotency: skip if already synced (regardless of which platform key we used)
        if (!force) {
          const existing = sqlite
            .prepare("SELECT id FROM xero_payout_syncs WHERE source_payout_id = ? AND source_platform LIKE 'shopify%' LIMIT 1")
            .get(String(payout.id));
          if (existing) {
            result.skipped++;
            continue;
          }
        }

        try {
          // Fetch + aggregate transactions
          const txs = await fetchShopifyPayoutTransactions(shop.channel, payout.id);
          const summary = aggregatePayoutTransactions(payout, txs, platformBase);

          // Load mappings for the resolved platform (might be shopify_afterpay if detected)
          const mappings = await loadAccountMappings(summary.platform);
          const tracking = await loadTrackingMapping(summary.platform);

          // Build + post the journal
          const built = buildPayoutJournal({ summary, mappings, tracking, status });
          if (!built.ok) {
            await logJournalFailure(runId, summary, built.error);
            result.errors.push({ payoutId: payout.id, platform: summary.platform, message: built.error });
            result.failed++;
            continue;
          }

          const post = await postManualJournal(built.payload);
          if (!post.success) {
            await logJournalFailure(runId, summary, post.error, built.payload);
            result.errors.push({ payoutId: payout.id, platform: summary.platform, message: post.error });
            result.failed++;
            continue;
          }

          // Persist success
          await db.insert(xeroPayoutSyncs).values({
            sourcePlatform: summary.platform,
            sourcePayoutId: String(payout.id),
            amount: summary.netPayoutAmount,
            currency: summary.currency,
            paidAt: payout.date,
            xeroObjectType: "manual_journal",
            xeroObjectId: post.manualJournalId,
            syncRunId: runId,
          });

          await db.insert(xeroJournalLog).values({
            syncRunId: runId,
            sourcePlatform: summary.platform,
            sourceId: String(payout.id),
            xeroObjectType: "manual_journal",
            xeroObjectId: post.manualJournalId,
            status: "success",
            amount: summary.netPayoutAmount,
            currency: summary.currency,
            payload: JSON.stringify({ kind: "revenue", summary, journal: built.payload, warnings: built.warnings }),
            response: JSON.stringify({ manualJournalId: post.manualJournalId, status: post.status }),
          });

          // Slack: payout synced 💸
          void (async () => {
            try {
              const { notifyPayoutReceived } = await import("@/modules/integrations/lib/slack/notifications");
              await notifyPayoutReceived({
                payoutId: payout.id,
                platform: summary.platform,
                amount: summary.netPayoutAmount,
                currency: summary.currency,
                date: summary.payoutDate,
                manualJournalId: post.manualJournalId,
                reconciliationDelta: summary.reconciliationDelta,
              });
            } catch (e) {
              console.error("[payout-sync] Slack payout alert failed:", e);
            }
          })();

          // ── COGS companion journal ──
          try {
            await postCogsCompanion({
              runId,
              channel: shop.channel,
              summary,
              tracking,
              status,
            });
          } catch (e) {
            // Don't fail the payout sync if COGS can't post — log it as a
            // warning so the user can re-run with a fix later.
            const message = e instanceof Error ? e.message : "Unknown";
            console.error(`[xero/payout-sync] COGS companion failed for payout ${payout.id}:`, e);
            result.errors.push({
              payoutId: payout.id,
              platform: summary.platform,
              message: `Revenue journal posted, but COGS companion failed: ${message}`,
            });
          }

          result.successful++;
        } catch (e) {
          const message = e instanceof Error ? e.message : "Unknown";
          await logJournalFailure(runId, { payoutId: payout.id, platform: platformBase } as Partial<PayoutSummary>, message);
          result.errors.push({ payoutId: payout.id, platform: shop.channel, message });
          result.failed++;
        }
      }
    }

    await db.update(xeroSyncRuns).set({
      status: "completed",
      totalPayouts: result.totalPayouts,
      successful: result.successful,
      failed: result.failed,
      completedAt: new Date().toISOString(),
    }).where(eq(xeroSyncRuns.id, runId));

    // Slack: alert on per-payout failures (sent inline above per failure
    // is too noisy for a multi-shop sync; aggregate at the run level).
    if (result.failed > 0) {
      void (async () => {
        try {
          const { notifyXeroSyncFailed } = await import("@/modules/integrations/lib/slack/notifications");
          await notifyXeroSyncFailed({
            payoutId: result.errors[0]?.payoutId ?? null,
            platform: result.errors[0]?.platform ?? null,
            errorMessage: `${result.failed} of ${result.totalPayouts} payouts failed. First error: ${result.errors[0]?.message ?? "unknown"}`,
            fixUrl: "https://theframe.getjaxy.com/settings/integrations/xero",
          });
        } catch (e) { console.error("[payout-sync] Slack xero_sync_failed alert failed:", e); }
      })();
    }

    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown";
    await db.update(xeroSyncRuns).set({
      status: "failed",
      errorMessage: message,
      totalPayouts: result.totalPayouts,
      successful: result.successful,
      failed: result.failed,
      completedAt: new Date().toISOString(),
    }).where(eq(xeroSyncRuns.id, runId));
    result.errors.push({ payoutId: null, platform: null, message: `Fatal: ${message}` });

    // Slack: fatal sync failure
    void (async () => {
      try {
        const { notifyXeroSyncFailed } = await import("@/modules/integrations/lib/slack/notifications");
        await notifyXeroSyncFailed({
          payoutId: null,
          platform: null,
          errorMessage: `Sync run aborted: ${message}`,
          fixUrl: "https://theframe.getjaxy.com/settings/integrations/xero",
        });
      } catch (slackError) { console.error("[payout-sync] Slack alert failed:", slackError); }
    })();

    return result;
  }
}

async function loadAccountMappings(platform: string): Promise<Map<string, AccountMapping>> {
  const rows = await db.select().from(xeroAccountMappings).where(eq(xeroAccountMappings.sourcePlatform, platform));
  const map = new Map<string, AccountMapping>();
  for (const r of rows) {
    if (!r.xeroAccountCode) continue;
    map.set(r.category, {
      category: r.category,
      xeroAccountCode: r.xeroAccountCode,
      xeroAccountName: r.xeroAccountName ?? null,
      side: "debit",  // unused — builder consults SIDE_FROM_GUIDE
    });
  }
  return map;
}

async function loadTrackingMapping(platform: string): Promise<TrackingMapping | null> {
  const [row] = await db.select().from(xeroTrackingMappings).where(eq(xeroTrackingMappings.sourcePlatform, platform));
  if (!row) return null;
  return {
    trackingCategoryId: row.trackingCategoryId,
    trackingCategoryName: row.trackingCategoryName ?? null,
    trackingOptionId: row.trackingOptionId,
    trackingOptionName: row.trackingOptionName ?? null,
  };
}

async function logJournalFailure(
  runId: string,
  summary: Partial<PayoutSummary>,
  errorMessage: string,
  payload?: unknown,
): Promise<void> {
  try {
    await db.insert(xeroJournalLog).values({
      syncRunId: runId,
      sourcePlatform: summary.platform || "unknown",
      sourceId: String(summary.payoutId || "unknown"),
      xeroObjectType: "manual_journal",
      xeroObjectId: null,
      status: "failed",
      amount: summary.netPayoutAmount ?? null,
      currency: summary.currency ?? null,
      payload: payload ? JSON.stringify(payload) : null,
      response: null,
      errorMessage,
    });
  } catch (e) {
    console.error("[xero/payout-sync] failed to write journal log:", e);
  }
}

/**
 * Post the COGS companion journal for a successfully-synced payout.
 * Throws on failure; the caller decides whether to bubble up or log.
 */
async function postCogsCompanion(opts: {
  runId: string;
  channel: string;
  summary: PayoutSummary;
  tracking: TrackingMapping | null;
  status: "POSTED" | "DRAFT";
}): Promise<void> {
  const { runId, channel, summary, tracking, status } = opts;

  // Aggregate orders → SKU breakdown
  const aggregation: CogsAggregation = await aggregateCogsForPayout(channel, summary.orderIds);
  if (aggregation.lines.length === 0) {
    // Nothing to post — log a skipped row for traceability.
    await db.insert(xeroJournalLog).values({
      syncRunId: runId,
      sourcePlatform: summary.platform,
      sourceId: String(summary.payoutId),
      xeroObjectType: "manual_journal_cogs",
      xeroObjectId: null,
      status: "skipped",
      amount: 0,
      currency: summary.currency,
      payload: JSON.stringify({ kind: "cogs", aggregation }),
      response: null,
      errorMessage: aggregation.warnings.join("; ") || "No COGS lines",
    });
    return;
  }

  const accounts = await loadCogsAccounts();
  if (!accounts) {
    await db.insert(xeroJournalLog).values({
      syncRunId: runId,
      sourcePlatform: summary.platform,
      sourceId: String(summary.payoutId),
      xeroObjectType: "manual_journal_cogs",
      xeroObjectId: null,
      status: "failed",
      amount: aggregation.totalCost,
      currency: summary.currency,
      payload: JSON.stringify({ kind: "cogs", aggregation }),
      response: null,
      errorMessage: "Shared cogs / inventory mappings not configured",
    });
    return;
  }

  const built = buildCogsJournal({
    aggregation,
    accounts,
    tracking,
    payoutId: summary.payoutId,
    payoutDate: summary.payoutDate,
    platform: summary.platform,
    status,
  });
  if (!built.ok) {
    await db.insert(xeroJournalLog).values({
      syncRunId: runId,
      sourcePlatform: summary.platform,
      sourceId: String(summary.payoutId),
      xeroObjectType: "manual_journal_cogs",
      xeroObjectId: null,
      status: "failed",
      amount: aggregation.totalCost,
      currency: summary.currency,
      payload: JSON.stringify({ kind: "cogs", aggregation }),
      response: null,
      errorMessage: built.error,
    });
    return;
  }

  const post = await postManualJournal(built.payload);
  if (!post.success) {
    await db.insert(xeroJournalLog).values({
      syncRunId: runId,
      sourcePlatform: summary.platform,
      sourceId: String(summary.payoutId),
      xeroObjectType: "manual_journal_cogs",
      xeroObjectId: null,
      status: "failed",
      amount: aggregation.totalCost,
      currency: summary.currency,
      payload: JSON.stringify({ kind: "cogs", aggregation, journal: built.payload }),
      response: null,
      errorMessage: post.error,
    });
    return;
  }

  // Persist success + per-line audit detail.
  const [journalLogRow] = await db.insert(xeroJournalLog).values({
    syncRunId: runId,
    sourcePlatform: summary.platform,
    sourceId: String(summary.payoutId),
    xeroObjectType: "manual_journal_cogs",
    xeroObjectId: post.manualJournalId,
    status: "success",
    amount: aggregation.totalCost,
    currency: summary.currency,
    payload: JSON.stringify({
      kind: "cogs",
      aggregation,
      journal: built.payload,
      warnings: built.warnings,
    }),
    response: JSON.stringify({ manualJournalId: post.manualJournalId, status: post.status }),
  }).returning();

  // Per-line rows for fast SKU-level audit queries.
  for (const line of aggregation.lines) {
    if (line.lineTotal <= 0) continue;
    await db.insert(xeroJournalLogLines).values({
      journalLogId: journalLogRow.id,
      sku: line.sku,
      skuId: line.skuId,
      productName: line.productName,
      colorName: line.colorName,
      quantity: line.quantity,
      unitCostAtSale: line.unitCostAtSale,
      lineTotal: line.lineTotal,
      side: "debit",
      accountCode: accounts.cogsAccountCode,
      trackingOptionId: tracking?.trackingOptionId ?? null,
    });
    await db.insert(xeroJournalLogLines).values({
      journalLogId: journalLogRow.id,
      sku: line.sku,
      skuId: line.skuId,
      productName: line.productName,
      colorName: line.colorName,
      quantity: line.quantity,
      unitCostAtSale: line.unitCostAtSale,
      lineTotal: line.lineTotal,
      side: "credit",
      accountCode: accounts.inventoryAccountCode,
      trackingOptionId: tracking?.trackingOptionId ?? null,
    });
  }

  // Slack: COGS journal posted 📚
  void (async () => {
    try {
      const { notifyCogsPosted } = await import("@/modules/integrations/lib/slack/notifications");
      await notifyCogsPosted({
        payoutId: summary.payoutId,
        platform: summary.platform,
        totalCost: aggregation.totalCost,
        currency: summary.currency,
        totalUnits: aggregation.totalUnits,
        skuCount: aggregation.lines.length,
        manualJournalId: post.manualJournalId,
      });
    } catch (e) {
      console.error("[payout-sync] Slack cogs alert failed:", e);
    }
  })();
}

/** Load the shared COGS + Inventory account mappings ("_shared" platform). */
async function loadCogsAccounts(): Promise<CogsAccounts | null> {
  const rows = await db
    .select()
    .from(xeroAccountMappings)
    .where(eq(xeroAccountMappings.sourcePlatform, SHARED_PLATFORM_KEY));
  const cogs = rows.find((r) => r.category === "cogs");
  const inv = rows.find((r) => r.category === "inventory");
  if (!cogs?.xeroAccountCode || !inv?.xeroAccountCode) return null;
  return {
    cogsAccountCode: cogs.xeroAccountCode,
    cogsAccountName: cogs.xeroAccountName ?? null,
    inventoryAccountCode: inv.xeroAccountCode,
    inventoryAccountName: inv.xeroAccountName ?? null,
  };
}

// Avoid unused import warnings — `and` may be useful when we add multi-shop filters
const _ = and;
void _;
