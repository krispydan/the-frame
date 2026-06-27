export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { resolveDepletionTarget } from "@/modules/finance/lib/fifo-engine";

/**
 * GET /api/v1/finance/cogs/order/[orderId]
 *
 * Per-order COGS status + the FIFO depletion detail behind it — powers the
 * order page's Costing panel. Status:
 *   not_shipped — order hasn't shipped (COGS not due yet)
 *   pending     — shipped, but the daily job hasn't costed it yet
 *   blocked     — an open exception (zero-cost / shortfall / unmapped)
 *   partial     — some units costed, some still uncosted
 *   costed      — every shipped unit has a depletion
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await ctx.params;

  const order = sqlite.prepare(
    "SELECT id, order_number, status, shipped_at FROM orders WHERE id = ?",
  ).get(orderId) as { id: string; order_number: string; status: string; shipped_at: string | null } | undefined;
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const items = sqlite.prepare(
    "SELECT id, sku, sku_id, product_name, color_name, quantity FROM order_items WHERE order_id = ?",
  ).all(orderId) as Array<{ id: string; sku: string | null; sku_id: string | null; product_name: string | null; color_name: string | null; quantity: number }>;

  const exceptions = sqlite.prepare(
    "SELECT type, units, detail, status, created_at, resolved_at FROM cogs_exceptions WHERE order_id = ? ORDER BY created_at DESC",
  ).all(orderId) as Array<{ type: string; units: number | null; detail: string | null; status: string; created_at: string; resolved_at: string | null }>;

  let totalCogs = 0;
  let depletedAt: string | null = null;
  let anyUncosted = false;
  let anyCosted = false;

  const lines = items.map((it) => {
    const orderedUnits = resolveDepletionTarget({ sku: it.sku, skuId: it.sku_id, quantity: it.quantity }).units;
    const layers = sqlite.prepare(`
      SELECT d.quantity AS qty, d.landed_cost_per_unit AS landedPerUnit, d.depleted_at AS depletedAt,
             l.shipping_method AS method, l.received_at AS receivedAt, l.po_number AS poNumber
      FROM inventory_cost_depletions d
      JOIN inventory_cost_layers l ON l.id = d.cost_layer_id
      WHERE d.order_item_id = ?
      ORDER BY l.received_at ASC
    `).all(it.id) as Array<{ qty: number; landedPerUnit: number; depletedAt: string; method: string | null; receivedAt: string; poNumber: string | null }>;

    const costedUnits = layers.reduce((s, l) => s + l.qty, 0);
    const lineCogs = layers.reduce((s, l) => s + l.qty * l.landedPerUnit, 0);
    totalCogs += lineCogs;
    if (layers.length) depletedAt = depletedAt || layers[0].depletedAt;
    if (costedUnits >= orderedUnits && orderedUnits > 0) anyCosted = true;
    if (costedUnits < orderedUnits) anyUncosted = true;

    return {
      orderItemId: it.id,
      sku: it.sku,
      productName: [it.product_name, it.color_name].filter(Boolean).join(" — "),
      orderedUnits,
      costedUnits,
      landedCost: Math.round(lineCogs * 100) / 100,
      layers,
    };
  });

  const openException = exceptions.find((e) => e.status === "open");
  let status: string;
  if (!order.shipped_at) status = "not_shipped";
  else if (openException) status = "blocked";
  else if (!anyCosted && anyUncosted) status = "pending";
  else if (anyUncosted) status = "partial";
  else status = "costed";

  return NextResponse.json({
    orderId: order.id,
    orderNumber: order.order_number,
    status,
    blockedBy: openException?.type ?? null,
    totalCogs: Math.round(totalCogs * 100) / 100,
    depletedAt,
    lines,
    exceptions,
  });
}
