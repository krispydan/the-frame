/**
 * Per-order economics — one implementation of "what did this order make?"
 * used by the order show page, the customer profit table, and anywhere else
 * that talks about per-order profit.
 *
 *   revenue        order.subtotal (post-discount, pre-shipping/tax — matches
 *                  the P&L's revenue basis)
 *   cogs           catalog cost_price × qty per line (null when any line has
 *                  no cost on file — partial COGS must not masquerade as full)
 *   threePl        fulfillment + postage. ACTUAL when the order appears on an
 *                  imported Big Sky invoice; otherwise ESTIMATED from the
 *                  contract rate card + historical postage medians. The two
 *                  are NEVER mixed — an order is either fully actual or fully
 *                  estimated, and `basis` says which (per Daniel, Aug 2026).
 *   netProfit      revenue − cogs − threePl.total + shipping charged
 *                  (shipping revenue re-enters here because postage is a cost)
 */
import { sqlite } from "@/lib/db";
import { resolveDepletionTarget } from "@/modules/finance/lib/fifo-engine";

export interface OrderEconomics {
  orderId: string;
  revenue: number;
  shippingCharged: number;
  cogs: number | null;
  cogsComplete: boolean;
  threePl: {
    basis: "actual" | "estimated" | "none";
    fulfillment: number;
    postage: number;
    other: number;
    total: number;
  };
  /** revenue + shipping − cogs − 3PL. Null when COGS is incomplete. */
  netProfit: number | null;
  netMarginPct: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// ── Rate card (for estimates) ──

interface EstimatorRates {
  dtc: { base: number; addl: number };
  wholesale: { base: number; tier2to10: number; tier10plus: number };
}

function loadEstimatorRates(): EstimatorRates {
  const rows = sqlite.prepare(
    "SELECT service_key, rate_json FROM three_pl_rate_card ORDER BY effective_from ASC",
  ).all() as Array<{ service_key: string; rate_json: string }>;
  const byKey = new Map<string, Record<string, number>>();
  for (const r of rows) {
    try { byKey.set(r.service_key, JSON.parse(r.rate_json)); } catch { /* ignore */ }
  }
  const dtc = byKey.get("fulfillment_dtc") ?? {};
  const ws = byKey.get("fulfillment_wholesale") ?? {};
  return {
    dtc: { base: Number(dtc.base ?? 2.15), addl: Number(dtc.addl ?? 0.68) },
    wholesale: {
      base: Number(ws.base ?? 1.85),
      tier2to10: Number(ws.tier2to10 ?? 0.38),
      tier10plus: Number(ws.tier10plus ?? 0.18),
    },
  };
}

/**
 * Median ACTUAL postage per channel from the imported invoices — the best
 * available guess for an order whose invoice hasn't arrived yet. Falls back
 * to observed May–July 2026 medians when a channel has no history.
 */
function loadPostageMedians(): Map<string, number> {
  const rows = sqlite.prepare(`
    SELECT o.channel AS channel, c.amount AS amount
    FROM three_pl_charges c
    JOIN orders o ON o.id = c.order_id
    WHERE c.charge_type LIKE 'shipping_%' AND c.amount > 0
  `).all() as Array<{ channel: string; amount: number }>;
  const byChannel = new Map<string, number[]>();
  for (const r of rows) {
    (byChannel.get(r.channel) ?? byChannel.set(r.channel, []).get(r.channel)!).push(r.amount);
  }
  const medians = new Map<string, number>();
  for (const [ch, arr] of byChannel) {
    arr.sort((a, b) => a - b);
    medians.set(ch, arr[Math.floor(arr.length / 2)]);
  }
  return medians;
}

const FALLBACK_POSTAGE: Record<string, number> = {
  shopify_dtc: 5.5,
  shopify_wholesale: 10.5,
  faire: 10.5,
  direct: 10.5,
  phone: 10.5,
};

/** Pack-expanded unit count for an order (a 12PK line counts as 12). */
function orderUnits(orderId: string): number {
  const items = sqlite.prepare(
    "SELECT sku, sku_id, quantity FROM order_items WHERE order_id = ?",
  ).all(orderId) as Array<{ sku: string | null; sku_id: string | null; quantity: number }>;
  let units = 0;
  for (const it of items) {
    try {
      const r = resolveDepletionTarget({ sku: it.sku, skuId: it.sku_id, quantity: 1 });
      units += it.quantity * (r.packSize || 1);
    } catch {
      units += it.quantity;
    }
  }
  return units;
}

/**
 * Estimate 3PL cost for an order with no invoice data yet. Fulfillment comes
 * straight from the contract rate card (deterministic); postage from the
 * channel's historical median. Billed units ≈ 2× frames (each frame's case is
 * picked separately — observed exactly on the May–July invoices).
 */
export function estimateThreePlCost(orderId: string, channel: string): { fulfillment: number; postage: number } {
  const rates = loadEstimatorRates();
  const frames = orderUnits(orderId);
  const units = frames * 2; // frame + its case, per observed billing
  let fulfillment = 0;
  if (units > 0) {
    if (channel === "shopify_dtc") {
      fulfillment = rates.dtc.base + rates.dtc.addl * (units - 1);
    } else {
      fulfillment =
        rates.wholesale.base +
        rates.wholesale.tier2to10 * Math.min(Math.max(units - 1, 0), 9) +
        rates.wholesale.tier10plus * Math.max(units - 10, 0);
    }
  }
  const medians = loadPostageMedians();
  const postage = medians.get(channel) ?? FALLBACK_POSTAGE[channel] ?? 8;
  return { fulfillment: r2(fulfillment), postage: r2(postage) };
}

/**
 * Compute economics for a set of orders (batched — used by the customer page
 * for its whole order list, and by the order API for one).
 */
export function getOrderEconomics(orderIds: string[]): Map<string, OrderEconomics> {
  const out = new Map<string, OrderEconomics>();
  if (orderIds.length === 0) return out;

  const orderStmt = sqlite.prepare(
    "SELECT id, channel, subtotal, shipping, status FROM orders WHERE id = ?",
  );
  const itemsStmt = sqlite.prepare(
    "SELECT oi.sku, oi.quantity, cs.cost_price AS cost FROM order_items oi LEFT JOIN catalog_skus cs ON cs.sku = oi.sku WHERE oi.order_id = ?",
  );
  const chargesStmt = sqlite.prepare(
    "SELECT charge_type, amount FROM three_pl_charges WHERE order_id = ?",
  );

  for (const orderId of orderIds) {
    const order = orderStmt.get(orderId) as { id: string; channel: string; subtotal: number; shipping: number; status: string } | undefined;
    if (!order) continue;

    // COGS
    const items = itemsStmt.all(orderId) as Array<{ sku: string | null; quantity: number; cost: number | null }>;
    let cogs = 0;
    let cogsComplete = items.length > 0;
    for (const it of items) {
      if (it.cost == null || it.cost <= 0) { cogsComplete = false; continue; }
      cogs += it.cost * it.quantity;
    }

    // 3PL: actual if any invoice charges exist for the order, else estimated.
    const charges = chargesStmt.all(orderId) as Array<{ charge_type: string; amount: number }>;
    let threePl: OrderEconomics["threePl"];
    if (charges.length > 0) {
      const fulfillment = charges.filter((c) => c.charge_type.startsWith("fulfillment_")).reduce((a, c) => a + c.amount, 0);
      const postage = charges.filter((c) => c.charge_type.startsWith("shipping_")).reduce((a, c) => a + c.amount, 0);
      const other = charges.filter((c) => !c.charge_type.startsWith("fulfillment_") && !c.charge_type.startsWith("shipping_")).reduce((a, c) => a + c.amount, 0);
      threePl = { basis: "actual", fulfillment: r2(fulfillment), postage: r2(postage), other: r2(other), total: r2(fulfillment + postage + other) };
    } else if (order.status === "cancelled") {
      threePl = { basis: "none", fulfillment: 0, postage: 0, other: 0, total: 0 };
    } else {
      const est = estimateThreePlCost(orderId, order.channel);
      threePl = { basis: "estimated", fulfillment: est.fulfillment, postage: est.postage, other: 0, total: r2(est.fulfillment + est.postage) };
    }

    const revenue = order.subtotal ?? 0;
    const shippingCharged = order.shipping ?? 0;
    const netProfit = cogsComplete ? r2(revenue + shippingCharged - cogs - threePl.total) : null;
    out.set(orderId, {
      orderId,
      revenue: r2(revenue),
      shippingCharged: r2(shippingCharged),
      cogs: cogsComplete ? r2(cogs) : null,
      cogsComplete,
      threePl,
      netProfit,
      netMarginPct: netProfit != null && revenue > 0 ? r2((netProfit / revenue) * 100) : null,
    });
  }
  return out;
}
