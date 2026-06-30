/**
 * Stage 2 of the accrual revenue-recognition flow.
 *
 * Stage 1 ("payout sync") parks gross revenue in Deferred Revenue (2200) and
 * the net amount in Receivables Holding (1100) → swept to BANK clearing.
 * No revenue is recognized at that point.
 *
 * Stage 2 ("this file") runs daily and finds orders that have:
 *   - shipped (shipped_at is not null)            ← ASC 606 trigger
 *   - NOT yet been recognized                     ← idempotency
 *   - a successfully-synced payout                ← Deferred Revenue exists
 *   - not been cancelled
 *
 * For each such order it posts a per-order ManualJournal:
 *   DR  Deferred Revenue        2200   (clear the liability)
 *   CR  Sales Revenue (channel) 4030/4000  (finally earned)
 *   DR  Cost of Goods Sold      5000   (matching principle)
 *   CR  Inventory               1400
 *   Tracking: Sales Channel = <channel>
 *
 * Then records the recognition in `order_revenue_recognitions` so re-runs
 * are no-ops.
 */

import { db, sqlite } from "@/lib/db";
import { xeroAccountMappings, xeroTrackingMappings, SHARED_PLATFORM_KEY } from "@/modules/integrations/schema/xero";
import { orderRevenueRecognitions } from "@/modules/finance/schema";
import { eq, inArray } from "drizzle-orm";
import { postManualJournal } from "@/modules/finance/lib/xero-client";

// ── Shape of a row we're going to recognize ──
interface ShippedOrderRow {
  orderId: string;
  externalOrderId: string | null;
  orderNumber: string;
  channel: string;
  total: number;
  currency: string | null;
  shippedAt: string;
  payoutExternalId: string;       // "shopify_payout_..." or "faire_payout_..."
  /**
   * Where the payout originated — `shopify_dtc`, `shopify_wholesale`, or
   * `faire`. This is the AUTHORITATIVE source-of-truth for which Xero
   * Sales account + tracking option to use, not the local `channel`
   * column on the order (which is `shopify_wholesale` for everything in
   * the wholesale store, INCLUDING Faire orders that get synced in).
   */
  payoutPlatform: string;
}

export interface RecognitionRunResult {
  ok: boolean;
  attempted: number;
  recognized: number;
  skipped: number;
  failed: number;
  details: Array<{
    orderNumber: string;
    status: "recognized" | "skipped" | "failed";
    reason?: string;
    revenue?: number;
    cogs?: number;
  }>;
}

const HUMAN_PLATFORM: Record<string, string> = {
  shopify_dtc: "Shopify Retail",
  shopify_wholesale: "Shopify Wholesale",
  faire: "Faire",
  amazon: "Amazon",
  tiktok_shop: "TikTok Shop",
};

const SUPPORTED_CHANNELS = ["shopify_dtc", "shopify_wholesale"];

/**
 * Main entry point — invoked by cron registry.
 */
export async function runShipmentRevenueRecognition(): Promise<RecognitionRunResult> {
  const result: RecognitionRunResult = {
    ok: true,
    attempted: 0,
    recognized: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  // Under the settlement-date invoice model, revenue is recognized at payout
  // (the ACCREC invoice), so this Stage-2 deferred→sales recognition must NOT
  // run — it would double-count. No-op when the invoice model is active.
  const { getPayoutRevenueModel } = await import("@/modules/integrations/lib/xero/payout-revenue-model");
  if (getPayoutRevenueModel() === "invoice") {
    result.details.push({ orderNumber: "-", status: "skipped", reason: "settlement-invoice model active — Stage-2 recognition disabled" });
    return result;
  }

  // Pull every candidate order: shipped + unrecognized + payout was synced.
  // The join through settlement_line_items → settlements lets us find which
  // payout the order belonged to; the join through xero_payout_syncs confirms
  // Deferred Revenue exists in Xero (otherwise we'd debit a non-existent
  // liability balance).
  //
  // External IDs can be either `shopify_payout_<id>` (Shopify Payments) or
  // `faire_payout_<id>` (Faire per-order synthetic settlement). Strip
  // whichever prefix is present before joining to xero_payout_syncs.
  const orders = sqlite.prepare(`
    SELECT
      o.id                  AS orderId,
      o.external_id         AS externalOrderId,
      o.order_number        AS orderNumber,
      o.channel             AS channel,
      o.total               AS total,
      o.currency            AS currency,
      o.shipped_at          AS shippedAt,
      s.external_id         AS payoutExternalId,
      xps.source_platform   AS payoutPlatform
    FROM orders o
    INNER JOIN settlement_line_items sli ON sli.order_id = o.id
    INNER JOIN settlements s             ON s.id          = sli.settlement_id
    INNER JOIN xero_payout_syncs xps     ON xps.source_payout_id IN (
        REPLACE(s.external_id, 'shopify_payout_', ''),
        REPLACE(s.external_id, 'faire_payout_', '')
      )
    WHERE o.shipped_at IS NOT NULL
      AND (o.status IS NULL OR o.status != 'cancelled')
      AND o.channel IN (${SUPPORTED_CHANNELS.map(() => "?").join(",")})
      AND o.id NOT IN (SELECT order_id FROM order_revenue_recognitions)
    GROUP BY o.id
    ORDER BY o.shipped_at ASC
  `).all(...SUPPORTED_CHANNELS) as ShippedOrderRow[];

  if (orders.length === 0) {
    return result;
  }

  // Resolve account + tracking mappings per PAYOUT PLATFORM (not local
  // order channel). Faire orders live in our orders table as
  // `shopify_wholesale` because Faire syncs them into our Shopify
  // wholesale store, but the revenue + tracking must follow the Faire
  // platform so they hit 4040 Sales — Faire Wholesale with the Faire
  // tracking option, not 4030 / Shopify - Wholesale.
  //
  // We pre-load configs for all platforms that might appear in
  // xero_payout_syncs.source_platform: the Shopify channel set + `faire`.
  const platformMappings = new Map<string, ChannelXeroConfig | null>();
  for (const platform of [...SUPPORTED_CHANNELS, "faire"]) {
    platformMappings.set(platform, await loadChannelXeroConfig(platform));
  }

  for (const order of orders) {
    result.attempted++;
    const cfg = platformMappings.get(order.payoutPlatform) ?? null;
    if (!cfg) {
      result.skipped++;
      result.details.push({
        orderNumber: order.orderNumber,
        status: "skipped",
        reason: `Missing Xero account mappings for payout platform ${order.payoutPlatform}`,
      });
      continue;
    }

    // COGS is NO LONGER posted here. It's owned entirely by the daily
    // FIFO COGS job (finance/lib/daily-cogs.ts), which recognizes COGS at
    // shipment using true landed cost from inventory_cost_layers — decoupled
    // from this payout-coupled revenue job. Posting COGS here too would
    // double-count. This journal is revenue-recognition ONLY:
    //   DR 2050 Deferred Revenue / CR 4030|4040 Sales.
    // See plan: "Phase 2 — Decouple COGS from revenue".
    const journal = buildShipmentRecognitionJournal(order, cfg);
    const post = await postManualJournal(journal);
    if (!post.success) {
      result.failed++;
      result.ok = false;
      result.details.push({
        orderNumber: order.orderNumber,
        status: "failed",
        reason: post.error,
      });
      continue;
    }

    // Record the recognition (idempotency anchor)
    await db.insert(orderRevenueRecognitions).values({
      orderId: order.orderId,
      externalOrderId: order.externalOrderId,
      payoutExternalId: order.payoutExternalId,
      channel: order.channel,
      recognizedAt: order.shippedAt.slice(0, 10),
      revenueAmount: order.total,
      cogsAmount: 0, // COGS handled by the daily FIFO COGS job, not here
      currency: order.currency || "USD",
      xeroManualJournalId: post.manualJournalId,
    });

    result.recognized++;
    result.details.push({
      orderNumber: order.orderNumber,
      status: "recognized",
      revenue: order.total,
      cogs: 0,
    });
  }

  return result;
}

// ── Helpers ──

export interface ChannelXeroConfig {
  salesAccountCode: string;
  deferredRevenueAccountCode: string;
  cogsAccountCode: string;
  inventoryAccountCode: string;
  trackingCategoryId: string | null;
  trackingCategoryName: string | null;
  trackingOptionName: string | null;
}

export async function loadChannelXeroConfig(channel: string): Promise<ChannelXeroConfig | null> {
  const rows = await db
    .select()
    .from(xeroAccountMappings)
    .where(inArray(xeroAccountMappings.sourcePlatform, [channel, SHARED_PLATFORM_KEY]));

  const byCategory = new Map<string, string>();
  for (const r of rows) {
    if (!r.xeroAccountCode) continue;
    // Platform-specific wins over shared
    if (r.sourcePlatform === channel || !byCategory.has(r.category)) {
      byCategory.set(r.category, r.xeroAccountCode);
    }
  }

  const sales = byCategory.get("sales");
  const deferred = byCategory.get("deferred_revenue");
  const cogs = byCategory.get("cogs");
  const inv = byCategory.get("inventory");
  if (!sales || !deferred || !cogs || !inv) return null;

  const [tk] = await db.select().from(xeroTrackingMappings).where(eq(xeroTrackingMappings.sourcePlatform, channel));
  return {
    salesAccountCode: sales,
    deferredRevenueAccountCode: deferred,
    cogsAccountCode: cogs,
    inventoryAccountCode: inv,
    trackingCategoryId: tk?.trackingCategoryId ?? null,
    trackingCategoryName: tk?.trackingCategoryName ?? null,
    trackingOptionName: tk?.trackingOptionName ?? null,
  };
}

// Revenue-recognition ONLY (DR 2050 Deferred Revenue / CR 4030|4040 Sales).
// COGS is posted separately by the daily FIFO COGS job at shipment using true
// landed cost — see finance/lib/daily-cogs.ts.
function buildShipmentRecognitionJournal(
  order: ShippedOrderRow,
  cfg: ChannelXeroConfig,
) {
  // Narration follows the payout platform — Faire orders read as
  // "Faire order #X" even though they live in our orders table as
  // channel=shopify_wholesale.
  const platform = HUMAN_PLATFORM[order.payoutPlatform] ?? order.payoutPlatform;
  const tracking = cfg.trackingCategoryId
    ? [{
        TrackingCategoryID: cfg.trackingCategoryId,
        Name: cfg.trackingCategoryName ?? undefined,
        Option: cfg.trackingOptionName ?? "",
      }]
    : undefined;

  const lines: Array<Record<string, unknown>> = [
    // Revenue side: clear Deferred Revenue, recognize Sales Revenue
    {
      LineAmount: order.total,  // debit Deferred Revenue (liability → 0)
      AccountCode: cfg.deferredRevenueAccountCode,
      Description: `Recognize revenue at shipment — ${platform} order ${order.orderNumber}`,
      Tracking: tracking,
    },
    {
      LineAmount: -order.total, // credit Sales Revenue
      AccountCode: cfg.salesAccountCode,
      Description: `Sales — ${platform} order ${order.orderNumber} (shipped ${order.shippedAt.slice(0, 10)})`,
      Tracking: tracking,
    },
  ];

  const narration = `Revenue recognition — ${platform} order ${order.orderNumber} | revenue ${order.total.toFixed(2)} | ${order.shippedAt.slice(0, 10)} (COGS posted separately by daily FIFO job)`;

  return {
    Narration: narration,
    Date: order.shippedAt.slice(0, 10),
    Status: "POSTED" as const,
    JournalLines: lines,
  };
}
