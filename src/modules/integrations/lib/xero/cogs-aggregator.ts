/**
 * COGS aggregator — turns the orders that make up a Shopify payout into a
 * per-SKU breakdown of (qty sold, unit cost at sale, line total).
 *
 * Data flow:
 *   payout.orderIds  →  fetch orders from Shopify  →  for each line item:
 *     - parse SKU
 *     - look up local catalog_skus row by sku string
 *     - read cost_price (FOB unit cost)
 *     - aggregate by (sku) summing qty and total
 *
 * Returns CogsLine[] for the journal builder + a list of warnings (e.g.
 * SKU has no cost_price → posted at $0).
 */

import { sqlite } from "@/lib/db";
import { getShopifyClientByChannel } from "@/modules/integrations/lib/shopify/admin-api";

export type CogsLine = {
  sku: string;
  skuId: string | null;
  productName: string | null;
  colorName: string | null;
  quantity: number;
  unitCostAtSale: number;
  lineTotal: number;
};

export type CogsAggregation = {
  /** Per-SKU lines (sorted by line_total desc for nicer journal output). */
  lines: CogsLine[];
  /** Sum of line_total — the COGS debit amount and Inventory credit amount. */
  totalCost: number;
  /** Total units across all lines. */
  totalUnits: number;
  /** SKUs we couldn't look up locally OR had no cost_price. */
  warnings: string[];
};

/** Local SKU row shape (subset of catalog_skus + product join). */
type LocalSku = {
  id: string;
  cost_price: number | null;
  sku: string;
  color_name: string | null;
  product_name: string | null;
};

function lookupLocalSku(skuString: string): LocalSku | null {
  if (!skuString) return null;
  const row = sqlite.prepare(`
    SELECT s.id, s.cost_price, s.sku, s.color_name, p.name AS product_name
    FROM catalog_skus s
    LEFT JOIN catalog_products p ON p.id = s.product_id
    WHERE s.sku = ?
    LIMIT 1
  `).get(skuString) as LocalSku | undefined;
  return row ?? null;
}

type ShopifyLineItem = {
  sku: string | null;
  quantity: number;
  // We keep these for narration but don't use them for the cost calc.
  title?: string;
  variant_title?: string;
};

type ShopifyOrder = {
  id: number;
  line_items?: ShopifyLineItem[];
  refunds?: Array<{
    refund_line_items?: Array<{
      line_item_id: number;
      quantity: number;
      line_item?: { sku?: string | null };
    }>;
  }>;
};

/**
 * Fetch all orders for the payout from Shopify and aggregate COGS by SKU.
 *
 * @param channel    "retail" or "wholesale" (the connected shop's channel)
 * @param orderIds   list of Shopify order IDs from the payout's transactions
 */
export async function aggregateCogsForPayout(
  channel: string,
  orderIds: number[],
): Promise<CogsAggregation> {
  const warnings: string[] = [];
  if (orderIds.length === 0) {
    return { lines: [], totalCost: 0, totalUnits: 0, warnings: ["No orders found in payout"] };
  }

  const client = await getShopifyClientByChannel(channel);

  // Fetch each order. Shopify supports an `ids` filter that takes up to 250
  // comma-separated IDs per request, but using one-call-per-order is simpler
  // and the volume is small.
  const orders: ShopifyOrder[] = [];
  for (const id of orderIds) {
    try {
      const data = (await client.rest("GET", `/orders/${id}.json?status=any`)) as { order?: ShopifyOrder };
      if (data.order) orders.push(data.order);
    } catch (e) {
      warnings.push(`Failed to fetch order ${id}: ${e instanceof Error ? e.message : "Unknown"}`);
    }
  }

  // Aggregate by SKU. Net of refunded units so we don't book COGS on returns.
  const bySku = new Map<string, CogsLine>();

  for (const order of orders) {
    for (const li of order.line_items || []) {
      if (!li.sku) continue;
      addQty(bySku, li.sku, li.quantity, warnings);
    }
    // Subtract refunded line item quantities so net COGS reflects net sales
    for (const refund of order.refunds || []) {
      for (const r of refund.refund_line_items || []) {
        const sku = r.line_item?.sku;
        if (!sku || !r.quantity) continue;
        addQty(bySku, sku, -r.quantity, warnings);
      }
    }
  }

  // Drop zero-qty entries (refunds netted out the charge), compute totals
  const lines: CogsLine[] = [];
  let totalCost = 0;
  let totalUnits = 0;
  for (const [, line] of bySku) {
    if (line.quantity <= 0) continue;
    line.lineTotal = round2(line.unitCostAtSale * line.quantity);
    totalCost += line.lineTotal;
    totalUnits += line.quantity;
    lines.push(line);
  }
  lines.sort((a, b) => b.lineTotal - a.lineTotal);

  return { lines, totalCost: round2(totalCost), totalUnits, warnings };
}

function addQty(bySku: Map<string, CogsLine>, sku: string, qtyDelta: number, warnings: string[]): void {
  const existing = bySku.get(sku);
  if (existing) {
    existing.quantity += qtyDelta;
    return;
  }
  // First time seeing this SKU — look up local data
  const local = lookupLocalSku(sku);
  if (!local) {
    warnings.push(`Unknown SKU ${sku} — no catalog match, cost = $0`);
    bySku.set(sku, { sku, skuId: null, productName: null, colorName: null, quantity: qtyDelta, unitCostAtSale: 0, lineTotal: 0 });
    return;
  }
  if (local.cost_price == null) {
    warnings.push(`SKU ${sku} has no cost_price — using $0`);
  }
  bySku.set(sku, {
    sku,
    skuId: local.id,
    productName: local.product_name,
    colorName: local.color_name,
    quantity: qtyDelta,
    unitCostAtSale: local.cost_price ?? 0,
    lineTotal: 0,
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
