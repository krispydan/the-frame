/**
 * Amazon order import: `amazon_order_rows` (raw archive) → `orders` /
 * `order_items`.
 *
 * These orders exist for finance only — revenue recognition, COGS, P&L,
 * reconciliation and the dashboard all read from `orders`, so Amazon has to
 * be there or it is invisible to every one of them. They must never be
 * pushed outward: Amazon fulfils them itself (FBA) or they reach ShipHero
 * through Amazon's own channel, so a push from The Frame would double-ship.
 *
 * Safety is layered rather than trusted to a single check:
 *
 *  1. **Structural.** `order_number` is prefixed `AMZ-` and `external_id`
 *     `amazon:`, so the fuzzy ShipHero order matcher cannot bind a shipment
 *     to an Amazon row even by accident. `company_id` stays NULL, which
 *     alone neutralises four unfiltered scans (customer LTV stats,
 *     wholesale-conversion detection, mail suppression, Meta CAPI).
 *     `shipped_alert_sent_at` is pre-stamped so the ShipHero-triggered
 *     "order fulfilled" alert can never claim one.
 *  2. **Explicit guards.** `channel != 'amazon'` in the ShipHero matcher,
 *     the ShipHero sync scan, the stuck-order scan and sell-through.
 *  3. **Status discipline.** Amazon rows never land on `confirmed`, which is
 *     the state the stuck-order scan keys on.
 *
 * The importer deliberately skips the side effects the Shopify path runs:
 * no company/contact creation, no customer-account stats, no
 * wholesale-conversion detection, no Pipedrive deal, no inventory movements
 * (FBA stock is not in ShipHero's warehouse, and the hourly ShipHero
 * inventory sync would overwrite any decrement anyway), no international
 * shipping email.
 */

import { sqlite } from "@/lib/db";
import { toInternalSku, round2 } from "@/modules/integrations/lib/amazon/ingest";

/** Prefixes that keep Amazon rows structurally unmatchable by ShipHero logic. */
export const AMAZON_ORDER_NUMBER_PREFIX = "AMZ-";
export const AMAZON_EXTERNAL_ID_PREFIX = "amazon:";

export const amazonOrderNumber = (amazonOrderId: string) => `${AMAZON_ORDER_NUMBER_PREFIX}${amazonOrderId}`;
export const amazonExternalId = (amazonOrderId: string) => `${AMAZON_EXTERNAL_ID_PREFIX}${amazonOrderId}`;

/** Raw archive row, as selected for import. */
interface RawOrderRow {
  amazon_order_id: string;
  sku: string;
  asin: string | null;
  quantity: number;
  item_price: number;
  item_tax: number;
  item_promotion_discount: number;
  ship_promotion_discount: number;
  shipping_price: number;
  shipping_tax: number;
  order_status: string | null;
  item_status: string | null;
  fulfillment_channel: string | null;
  currency: string | null;
  purchase_date: string | null;
  last_updated_date: string | null;
}

export type LocalOrderStatus =
  | "pending" | "confirmed" | "picking" | "packed"
  | "shipped" | "delivered" | "returned" | "cancelled";

/**
 * Map Amazon's per-line statuses onto our order status.
 *
 * Never returns `confirmed`, `picking` or `packed`. Those describe work in
 * OUR warehouse, and `confirmed` in particular is what the stuck-order scan
 * alerts on after 48 hours — an Amazon order sitting in Pending is entirely
 * normal and not something anyone here can act on.
 *
 * A partially-shipped order counts as shipped: revenue recognition and COGS
 * key off `shipped_at`, and the shipped portion has genuinely transferred to
 * the customer. The remainder is picked up on a later sync when its own line
 * flips.
 */
export function mapAmazonStatus(itemStatuses: Array<string | null>): LocalOrderStatus {
  const statuses = itemStatuses.map((s) => (s ?? "").toLowerCase().trim()).filter(Boolean);
  if (statuses.length === 0) return "pending";

  // Amazon cancels only when every line is cancelled; a partial cancel leaves
  // the rest live, so the order is still a real sale.
  if (statuses.every((s) => s === "cancelled" || s === "canceled")) return "cancelled";
  if (statuses.some((s) => s === "shipped")) return "shipped";
  return "pending";
}

/**
 * Earliest update timestamp among shipped lines.
 *
 * This substitutes for a true ship timestamp. The natural source — the FBA
 * shipments report — times out on every request against this account, so
 * `last_updated_date` on a line whose `item_status` is Shipped is the best
 * available proxy. It is the update time rather than the ship time, but it
 * is same-day accurate, which is all that daily COGS and revenue
 * recognition require.
 */
export function deriveShippedAt(rows: Array<{ item_status: string | null; last_updated_date: string | null }>): string | null {
  const shipped = rows
    .filter((r) => (r.item_status ?? "").toLowerCase().trim() === "shipped")
    .map((r) => r.last_updated_date)
    .filter((d): d is string => !!d)
    .sort();
  return shipped[0] ?? null;
}

export interface ImportResult {
  /** Distinct Amazon orders considered. */
  ordersConsidered: number;
  ordersCreated: number;
  ordersUpdated: number;
  ordersUnchanged: number;
  itemsWritten: number;
  /** Lines whose SKU could not be resolved to catalog_skus. */
  unmappedSkus: string[];
  errors: Array<{ amazonOrderId: string; error: string }>;
}

/**
 * Resolve an Amazon SKU to a catalog SKU id, stripping the `-FBA` suffix and
 * falling back to the alias table.
 *
 * Returns null rather than guessing. An unresolved SKU surfaces as an
 * unmapped-SKU warning and, later, a COGS exception — never a silent
 * zero-cost line.
 */
export function resolveCatalogSku(amazonSku: string): { skuId: string | null; internalSku: string | null } {
  const internalSku = toInternalSku(amazonSku);
  if (!internalSku) return { skuId: null, internalSku: null };

  const direct = sqlite
    .prepare("SELECT id FROM catalog_skus WHERE sku = ? LIMIT 1")
    .get(internalSku) as { id: string } | undefined;
  if (direct) return { skuId: direct.id, internalSku };

  // The alias table is how one-off or historical SKU spellings are mapped
  // without code changes.
  try {
    const alias = sqlite
      .prepare("SELECT sku_id FROM catalog_sku_aliases WHERE alias = ? LIMIT 1")
      .get(internalSku) as { sku_id: string } | undefined;
    if (alias?.sku_id) return { skuId: alias.sku_id, internalSku };
  } catch {
    // Alias table is optional in some environments (e.g. minimal test DBs).
  }

  return { skuId: null, internalSku };
}

/**
 * Import Amazon orders from the raw archive into `orders` / `order_items`.
 *
 * Reads only from `amazon_order_rows`, never from Windsor — so it can be
 * re-run freely, and a mapping fix can be replayed over history without
 * needing upstream data that may no longer exist.
 */
export function importAmazonOrders(
  opts: { since?: string; until?: string; amazonOrderIds?: string[] } = {},
): ImportResult {
  const result: ImportResult = {
    ordersConsidered: 0,
    ordersCreated: 0,
    ordersUpdated: 0,
    ordersUnchanged: 0,
    itemsWritten: 0,
    unmappedSkus: [],
    errors: [],
  };

  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.amazonOrderIds?.length) {
    where.push(`amazon_order_id IN (${opts.amazonOrderIds.map(() => "?").join(",")})`);
    params.push(...opts.amazonOrderIds);
  }
  // Filter on purchase_date so a window means "orders placed then", which is
  // what an operator means. Status changes to older orders are picked up by
  // targeting them explicitly or by a wider window.
  if (opts.since) { where.push("purchase_date >= ?"); params.push(opts.since); }
  if (opts.until) { where.push("purchase_date <= ?"); params.push(`${opts.until}T23:59:59`); }

  const rows = sqlite.prepare(`
    SELECT amazon_order_id, sku, asin, quantity, item_price, item_tax,
           item_promotion_discount, ship_promotion_discount, shipping_price,
           shipping_tax, order_status, item_status, fulfillment_channel,
           currency, purchase_date, last_updated_date
    FROM amazon_order_rows
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY purchase_date ASC, amazon_order_id ASC
  `).all(...params) as RawOrderRow[];

  // Group lines into orders.
  const byOrder = new Map<string, RawOrderRow[]>();
  for (const row of rows) {
    const list = byOrder.get(row.amazon_order_id);
    if (list) list.push(row);
    else byOrder.set(row.amazon_order_id, [row]);
  }
  result.ordersConsidered = byOrder.size;

  const unmapped = new Set<string>();

  for (const [amazonOrderId, lines] of byOrder) {
    try {
      importOne(amazonOrderId, lines, result, unmapped);
    } catch (e) {
      result.errors.push({ amazonOrderId, error: (e as Error).message });
    }
  }

  result.unmappedSkus = [...unmapped].sort();
  return result;
}

function importOne(
  amazonOrderId: string,
  lines: RawOrderRow[],
  result: ImportResult,
  unmapped: Set<string>,
): void {
  const externalId = amazonExternalId(amazonOrderId);
  const orderNumber = amazonOrderNumber(amazonOrderId);

  const status = mapAmazonStatus(lines.map((l) => l.item_status));
  const shippedAt = deriveShippedAt(lines);
  const placedAt = lines.map((l) => l.purchase_date).filter(Boolean).sort()[0] ?? null;
  const currency = lines.find((l) => l.currency)?.currency ?? "USD";

  // Money. Amazon reports item_price as the LINE total (unit × qty), and
  // promotion discounts as positive magnitudes.
  const subtotal = round2(lines.reduce((s, l) => s + l.item_price, 0));
  const discount = round2(lines.reduce((s, l) => s + l.item_promotion_discount + l.ship_promotion_discount, 0));
  const shipping = round2(lines.reduce((s, l) => s + l.shipping_price, 0));
  const tax = round2(lines.reduce((s, l) => s + l.item_tax + l.shipping_tax, 0));
  const total = round2(subtotal - discount + shipping + tax);

  const existing = sqlite
    .prepare("SELECT id, status, shipped_at, total FROM orders WHERE external_id = ? LIMIT 1")
    .get(externalId) as { id: string; status: string; shipped_at: string | null; total: number } | undefined;

  const write = sqlite.transaction(() => {
    let orderId: string;

    if (existing) {
      // Adding a catalog_sku_aliases row and re-importing is the documented
      // fix for an unmapped SKU, so an order holding a SKU that would NOW
      // resolve must not be short-circuited as unchanged.
      //
      // The check is "would it resolve now", not merely "is it unresolved":
      // a SKU that genuinely has no mapping would otherwise force a rewrite
      // on every single import, forever.
      const unresolved = sqlite
        .prepare("SELECT sku FROM order_items WHERE order_id = ? AND sku_id IS NULL")
        .all(existing.id) as Array<{ sku: string | null }>;
      const hasNewlyResolvable = unresolved.some(
        (r) => r.sku && resolveCatalogSku(r.sku).skuId !== null,
      );

      const unchanged =
        !hasNewlyResolvable &&
        existing.status === status &&
        existing.shipped_at === shippedAt &&
        round2(existing.total) === total;

      if (unchanged) {
        result.ordersUnchanged++;
        return;
      }

      orderId = existing.id;
      // shipped_at is COALESCEd, never cleared. Revenue recognition and daily
      // COGS both key off it, and a later restatement that dropped the ship
      // timestamp would strand an already-posted journal against an order
      // that now looks unshipped. A cancelled-after-shipping order keeps its
      // ship date, which is the correct history.
      sqlite.prepare(`
        UPDATE orders SET
          status = ?, subtotal = ?, discount = ?, shipping = ?, tax = ?, total = ?,
          currency = ?, placed_at = COALESCE(?, placed_at),
          shipped_at = COALESCE(?, shipped_at),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(status, subtotal, discount, shipping, tax, total, currency, placedAt, shippedAt, orderId);
      result.ordersUpdated++;
    } else {
      orderId = crypto.randomUUID();
      sqlite.prepare(`
        INSERT INTO orders (
          id, order_number, company_id, contact_id, store_id, channel, status,
          external_id, subtotal, discount, shipping, tax, total, currency,
          source_name, shiphero_order_id, ship_to_country,
          placed_at, shipped_at, shipped_alert_sent_at, created_at, updated_at
        ) VALUES (?, ?, NULL, NULL, NULL, 'amazon', ?, ?, ?, ?, ?, ?, ?, ?, 'amazon', NULL, NULL, ?, ?, datetime('now'), datetime('now'), datetime('now'))
      `).run(
        orderId, orderNumber, status, externalId,
        subtotal, discount, shipping, tax, total, currency,
        placedAt, shippedAt,
      );
      result.ordersCreated++;
    }

    // Replace line items wholesale. Amazon restates orders (quantities and
    // prices change on partial cancels), and rewriting is simpler and safer
    // than diffing — but only for lines never costed, since deleting a line
    // that already has a COGS depletion would orphan that depletion and
    // silently drop the cost from the ledger.
    const costed = sqlite.prepare(`
      SELECT COUNT(*) AS n FROM inventory_cost_depletions d
      JOIN order_items oi ON oi.id = d.order_item_id
      WHERE oi.order_id = ?
    `).get(orderId) as { n: number } | undefined;

    if ((costed?.n ?? 0) === 0) {
      sqlite.prepare("DELETE FROM order_items WHERE order_id = ?").run(orderId);
      for (const line of lines) {
        const { skuId, internalSku } = resolveCatalogSku(line.sku);
        if (!skuId && internalSku) unmapped.add(line.sku);

        sqlite.prepare(`
          INSERT INTO order_items (
            id, order_id, product_id, sku_id, sku, product_name, quantity,
            unit_price, total_price
          ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
        `).run(
          crypto.randomUUID(),
          orderId,
          skuId,
          line.sku,
          internalSku ?? line.sku,
          Math.max(0, Math.trunc(line.quantity)),
          line.quantity > 0 ? round2(line.item_price / line.quantity) : 0,
          round2(line.item_price),
        );
        result.itemsWritten++;
      }
    }
  });

  write();
}
