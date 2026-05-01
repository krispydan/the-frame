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
  xeroAccountMappings,
  xeroTrackingMappings,
} from "@/modules/integrations/schema/xero";
import { listInstalledShops } from "@/modules/integrations/lib/shopify/admin-api";
import { eq, and } from "drizzle-orm";
import { fetchShopifyPayouts, fetchShopifyPayoutTransactions } from "./shopify-payouts";
import { aggregatePayoutTransactions, type PayoutSummary } from "./payout-aggregator";
import { buildPayoutJournal, type AccountMapping, type TrackingMapping } from "./journal-builder";
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
            payload: JSON.stringify({ summary, journal: built.payload, warnings: built.warnings }),
            response: JSON.stringify({ manualJournalId: post.manualJournalId, status: post.status }),
          });

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

// Avoid unused import warnings — `and` may be useful when we add multi-shop filters
const _ = and;
void _;
