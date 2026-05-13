/**
 * Shopify Payments Settlement Sync
 * 
 * Parses Shopify Payments payouts via Admin API or CSV import.
 * Maps to the unified settlement schema.
 */

import { db } from "@/lib/db";
import { settlements, settlementLineItems } from "@/modules/finance/schema";
import { eq } from "drizzle-orm";

interface ShopifyPayout {
  id: number;
  date: string;
  amount: string;
  currency: string;
  status: string;
}

interface ShopifyPayoutTransaction {
  id: number;
  type: string; // charge, refund, adjustment, payout
  source_id: number | null;
  source_order_id: number | null;
  amount: string;
  fee: string;
  net: string;
  currency: string;
}

/**
 * Sync Shopify Payments payouts for a given store.
 * Uses Shopify Admin API: GET /admin/api/{apiVersion}/shopify_payments/payouts.json
 * Requires `read_shopify_payments_payouts` scope on the access token.
 */
export async function syncShopifySettlements(
  storeDomain: string,
  accessToken: string,
  channel: "shopify_dtc" | "shopify_wholesale",
  options: { sinceId?: string; apiVersion?: string } = {}
): Promise<{ synced: number; skipped: number }> {
  const apiVersion = options.apiVersion || "2025-07";
  const baseUrl = `https://${storeDomain}/admin/api/${apiVersion}`;
  const headers = { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" };

  // Fetch payouts
  let url = `${baseUrl}/shopify_payments/payouts.json?status=paid&limit=50`;
  if (options.sinceId) url += `&since_id=${options.sinceId}`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Shopify API error: ${res.status} ${await res.text()}`);

  const { payouts } = (await res.json()) as { payouts: ShopifyPayout[] };
  let synced = 0;
  let skipped = 0;

  for (const payout of payouts) {
    const externalId = `shopify_payout_${payout.id}`;

    // Check if already synced
    const existing = db.select().from(settlements).where(eq(settlements.externalId, externalId)).get();
    if (existing) { skipped++; continue; }

    // Fetch payout transactions
    const txRes = await fetch(
      `${baseUrl}/shopify_payments/payouts/${payout.id}/transactions.json?limit=250`,
      { headers }
    );
    const { transactions } = txRes.ok
      ? (await txRes.json()) as { transactions: ShopifyPayoutTransaction[] }
      : { transactions: [] };

    // Calculate breakdowns
    let grossAmount = 0;
    let fees = 0;
    let adjustments = 0;
    const lineItems: Array<{ type: "sale" | "refund" | "fee" | "adjustment"; description: string; amount: number; orderId?: string }> = [];

    for (const tx of transactions) {
      const amount = parseFloat(tx.amount);
      const fee = parseFloat(tx.fee);

      switch (tx.type) {
        case "charge":
          grossAmount += amount;
          fees += Math.abs(fee);
          lineItems.push({
            type: "sale",
            description: `Order ${tx.source_order_id || tx.source_id}`,
            amount,
            orderId: tx.source_order_id ? String(tx.source_order_id) : undefined,
          });
          break;
        case "refund":
          lineItems.push({
            type: "refund",
            description: `Refund for order ${tx.source_order_id || tx.source_id}`,
            amount,
            orderId: tx.source_order_id ? String(tx.source_order_id) : undefined,
          });
          break;
        case "adjustment":
          adjustments += amount;
          lineItems.push({ type: "adjustment", description: tx.type, amount });
          break;
        default:
          // payout type or other — skip
          break;
      }
    }

    // Determine period — use payout date as period end, subtract 7 days for start (weekly)
    const periodEnd = payout.date;
    const startDate = new Date(payout.date);
    startDate.setDate(startDate.getDate() - 7);
    const periodStart = startDate.toISOString().split("T")[0];

    const netAmount = parseFloat(payout.amount);

    // Insert settlement
    const settlementId = crypto.randomUUID();
    db.insert(settlements).values({
      id: settlementId,
      channel,
      periodStart,
      periodEnd,
      grossAmount,
      fees,
      adjustments,
      netAmount,
      currency: payout.currency,
      externalId,
      status: "received",
      receivedAt: payout.date,
    }).run();

    // Insert line items
    for (const li of lineItems) {
      db.insert(settlementLineItems).values({
        settlementId,
        type: li.type,
        description: li.description,
        amount: li.amount,
        orderId: li.orderId,
      }).run();
    }

    // Add fee line item
    if (fees > 0) {
      db.insert(settlementLineItems).values({
        settlementId,
        type: "fee",
        description: "Shopify Payments processing fees",
        amount: -fees,
      }).run();
    }

    synced++;
  }

  return { synced, skipped };
}

/**
 * Orchestrator: loop every active Shopify shop in the DB and sync its
 * Payments payouts via the Admin API. Skips shops that don't have
 * Shopify Payments enabled (we detect via 402/422 on the payouts endpoint).
 *
 * Wired up from:
 *   - POST /api/v1/finance/settlements/sync  (UI button)
 *   - cron registry "shopify-settlements-sync"
 *
 * Idempotent — re-runs skip payouts already imported (via external_id).
 */
export async function syncSettlementsAllShops(): Promise<{
  ok: boolean;
  totals: { synced: number; skipped: number };
  perShop: Array<{
    channel: string;
    shopDomain: string;
    synced: number;
    skipped: number;
    error?: string;
  }>;
}> {
  // Lazy import to keep this module light when called from non-server contexts
  const { listInstalledShops } = await import("@/modules/integrations/lib/shopify/admin-api");
  const shops = await listInstalledShops();

  const perShop: Array<{ channel: string; shopDomain: string; synced: number; skipped: number; error?: string }> = [];
  let totalSynced = 0;
  let totalSkipped = 0;

  for (const shop of shops) {
    // Map admin-api channel ("retail"/"wholesale") → settlements.channel enum
    const settlementChannel: "shopify_dtc" | "shopify_wholesale" | null =
      shop.channel === "retail" ? "shopify_dtc"
      : shop.channel === "wholesale" ? "shopify_wholesale"
      : null;
    if (!settlementChannel) {
      perShop.push({
        channel: shop.channel,
        shopDomain: shop.shopDomain,
        synced: 0,
        skipped: 0,
        error: `Unsupported channel "${shop.channel}" — settlements table only models shopify_dtc / shopify_wholesale`,
      });
      continue;
    }

    try {
      const r = await syncShopifySettlements(
        shop.shopDomain,
        shop.accessToken,
        settlementChannel,
        { apiVersion: shop.apiVersion || undefined },
      );
      perShop.push({ channel: shop.channel, shopDomain: shop.shopDomain, ...r });
      totalSynced += r.synced;
      totalSkipped += r.skipped;
    } catch (e) {
      perShop.push({
        channel: shop.channel,
        shopDomain: shop.shopDomain,
        synced: 0,
        skipped: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    ok: perShop.every((s) => !s.error),
    totals: { synced: totalSynced, skipped: totalSkipped },
    perShop,
  };
}

/**
 * Import Shopify settlements from CSV (Shopify Payments payouts export).
 * Expected columns: Payout Date, Payout ID, Amount, Fee, Net, Type, Order, etc.
 */
export async function importShopifySettlementsFromCSV(
  csvData: string,
  channel: "shopify_dtc" | "shopify_wholesale"
): Promise<{ imported: number; skipped: number }> {
  // Dynamic import papaparse
  const Papa = await import("papaparse");
  const parsed = Papa.default.parse(csvData, { header: true, skipEmptyLines: true });

  // Group rows by Payout ID
  const payoutGroups = new Map<string, Array<Record<string, string>>>();
  for (const row of parsed.data as Record<string, string>[]) {
    const payoutId = row["Payout ID"] || row["payout_id"];
    if (!payoutId) continue;
    if (!payoutGroups.has(payoutId)) payoutGroups.set(payoutId, []);
    payoutGroups.get(payoutId)!.push(row);
  }

  let imported = 0;
  let skipped = 0;

  for (const [payoutId, rows] of payoutGroups) {
    const externalId = `shopify_payout_${payoutId}`;
    const existing = db.select().from(settlements).where(eq(settlements.externalId, externalId)).get();
    if (existing) { skipped++; continue; }

    let grossAmount = 0;
    let fees = 0;
    let adjustments = 0;
    const lineItems: Array<{ type: "sale" | "refund" | "fee" | "adjustment"; description: string; amount: number }> = [];

    for (const row of rows) {
      const amount = parseFloat(row["Amount"] || "0");
      const fee = parseFloat(row["Fee"] || "0");
      const type = (row["Type"] || "").toLowerCase();

      if (type === "charge" || type === "sale") {
        grossAmount += amount;
        fees += Math.abs(fee);
        lineItems.push({ type: "sale", description: `Order ${row["Order"] || ""}`.trim(), amount });
      } else if (type === "refund") {
        lineItems.push({ type: "refund", description: `Refund ${row["Order"] || ""}`.trim(), amount });
      } else if (type === "adjustment") {
        adjustments += amount;
        lineItems.push({ type: "adjustment", description: row["Description"] || "Adjustment", amount });
      }
    }

    const payoutDate = rows[0]["Payout Date"] || rows[0]["payout_date"] || new Date().toISOString().split("T")[0];
    const startDate = new Date(payoutDate);
    startDate.setDate(startDate.getDate() - 7);

    const netAmount = grossAmount - fees + adjustments;
    const settlementId = crypto.randomUUID();

    db.insert(settlements).values({
      id: settlementId,
      channel,
      periodStart: startDate.toISOString().split("T")[0],
      periodEnd: payoutDate,
      grossAmount,
      fees,
      adjustments,
      netAmount,
      currency: "USD",
      externalId,
      status: "received",
      receivedAt: payoutDate,
    }).run();

    for (const li of lineItems) {
      db.insert(settlementLineItems).values({ settlementId, ...li }).run();
    }
    if (fees > 0) {
      db.insert(settlementLineItems).values({
        settlementId,
        type: "fee",
        description: "Shopify Payments fees",
        amount: -fees,
      }).run();
    }

    imported++;
  }

  return { imported, skipped };
}
