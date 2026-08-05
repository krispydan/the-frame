export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET /api/v1/operations/three-pl/margin
 *
 * Shipping P&L by channel and month: what customers paid us for shipping
 * (orders.shipping — flat-price on retail, Faire's shipping line on
 * wholesale) vs what Big Sky actually charged (postage pass-through +
 * fulfillment labor). Faire sometimes nets positive — this makes that
 * visible instead of anecdotal.
 *
 * Only orders that appear on an imported invoice are counted, so revenue and
 * cost always cover the same order set (no fabricated margin from orders
 * whose costs haven't been billed yet).
 */
export async function GET() {
  const rows = sqlite.prepare(`
    WITH order_costs AS (
      SELECT
        c.order_id,
        SUM(CASE WHEN c.charge_type LIKE 'shipping_%' THEN c.amount ELSE 0 END) AS postage,
        SUM(CASE WHEN c.charge_type LIKE 'fulfillment_%' THEN c.amount ELSE 0 END) AS fulfillment
      FROM three_pl_charges c
      WHERE c.order_id IS NOT NULL
      GROUP BY c.order_id
    )
    SELECT
      o.channel,
      strftime('%Y-%m', o.placed_at) AS month,
      COUNT(*) AS orders,
      ROUND(SUM(o.shipping), 2) AS shippingRevenue,
      ROUND(SUM(oc.postage), 2) AS postage,
      ROUND(SUM(oc.fulfillment), 2) AS fulfillment,
      ROUND(SUM(o.shipping) - SUM(oc.postage), 2) AS postageMargin,
      ROUND(SUM(o.shipping) - SUM(oc.postage) - SUM(oc.fulfillment), 2) AS netAfterFulfillment
    FROM order_costs oc
    JOIN orders o ON o.id = oc.order_id
    GROUP BY o.channel, strftime('%Y-%m', o.placed_at)
    ORDER BY month DESC, o.channel
  `).all();

  // Channel lifetime rollup
  const byChannel = sqlite.prepare(`
    WITH order_costs AS (
      SELECT c.order_id,
        SUM(CASE WHEN c.charge_type LIKE 'shipping_%' THEN c.amount ELSE 0 END) AS postage,
        SUM(CASE WHEN c.charge_type LIKE 'fulfillment_%' THEN c.amount ELSE 0 END) AS fulfillment
      FROM three_pl_charges c WHERE c.order_id IS NOT NULL GROUP BY c.order_id
    )
    SELECT o.channel, COUNT(*) AS orders,
      ROUND(SUM(o.shipping), 2) AS shippingRevenue,
      ROUND(SUM(oc.postage), 2) AS postage,
      ROUND(SUM(oc.fulfillment), 2) AS fulfillment,
      ROUND(SUM(o.shipping) - SUM(oc.postage), 2) AS postageMargin
    FROM order_costs oc JOIN orders o ON o.id = oc.order_id
    GROUP BY o.channel ORDER BY orders DESC
  `).all();

  return NextResponse.json({ byMonth: rows, byChannel });
}
