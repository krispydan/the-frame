export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function GET() {
  const totalProspects = (sqlite.prepare("SELECT count(*) as c FROM companies").get() as { c: number }).c;

  const outreachReady = (sqlite.prepare(
    "SELECT count(*) as c FROM companies WHERE email IS NOT NULL AND email != '' AND status = 'qualified'"
  ).get() as { c: number }).c;

  const icpABCount = (sqlite.prepare(
    "SELECT count(*) as c FROM companies WHERE icp_tier IN ('A', 'B')"
  ).get() as { c: number }).c;

  const unscoredCount = (sqlite.prepare(
    "SELECT count(*) as c FROM companies WHERE icp_score IS NULL"
  ).get() as { c: number }).c;

  // Active deals (not closed stages) + pipeline value
  const activeDeals = (sqlite.prepare(
    "SELECT count(*) as c, coalesce(sum(value), 0) as total FROM deals WHERE stage NOT IN ('order_placed', 'not_interested')"
  ).get() as { c: number; total: number });

  // Pending orders + total revenue
  const pendingOrders = (sqlite.prepare(
    "SELECT count(*) as c FROM orders WHERE status IN ('pending', 'confirmed', 'picking', 'packed')"
  ).get() as { c: number }).c;

  const totalRevenue = (sqlite.prepare(
    "SELECT coalesce(sum(total), 0) as total FROM orders WHERE status NOT IN ('cancelled', 'returned')"
  ).get() as { total: number }).total;

  // Inventory: total units in warehouse + estimated value
  const inventoryStats = (sqlite.prepare(
    "SELECT coalesce(sum(quantity), 0) as totalUnits, count(*) as skuCount FROM inventory WHERE location = 'warehouse'"
  ).get() as { totalUnits: number; skuCount: number });

  // Inventory value: join inventory with catalog_skus to get cost_price * quantity
  const inventoryValue = (sqlite.prepare(
    `SELECT coalesce(sum(i.quantity * coalesce(s.cost_price, 0)), 0) as totalValue
     FROM inventory i
     LEFT JOIN catalog_skus s ON i.sku_id = s.id
     WHERE i.location IN ('warehouse', '3pl')`
  ).get() as { totalValue: number }).totalValue;

  // Revenue by channel
  const revenueByChannel = sqlite.prepare(
    `SELECT channel, coalesce(sum(total), 0) as revenue, count(*) as orderCount
     FROM orders
     WHERE status NOT IN ('cancelled', 'returned')
     GROUP BY channel`
  ).all() as Array<{ channel: string; revenue: number; orderCount: number }>;

  // Unread notifications
  const unreadNotifications = (sqlite.prepare(
    "SELECT count(*) as c FROM notifications WHERE read = 0 AND dismissed = 0"
  ).get() as { c: number }).c;

  // Low-stock alerts
  const lowStockAlerts = sqlite.prepare(`
    SELECT i.quantity, i.reorder_point, s.sku, s.color_name, p.name as product_name, p.sku_prefix
    FROM inventory i
    JOIN catalog_skus s ON i.sku_id = s.id
    JOIN catalog_products p ON s.product_id = p.id
    WHERE i.quantity <= i.reorder_point AND i.reorder_point > 0 AND i.location = 'warehouse'
    ORDER BY CAST(i.quantity AS REAL) / NULLIF(i.reorder_point, 0) ASC
    LIMIT 10
  `).all() as Array<{ quantity: number; reorder_point: number; sku: string; color_name: string | null; product_name: string; sku_prefix: string }>;

  // Enriched activity feed with entity names
  const recentActivity = sqlite.prepare(`
    SELECT
      af.*,
      CASE af.entity_type
        WHEN 'deal' THEN (SELECT title FROM deals WHERE id = af.entity_id)
        WHEN 'order' THEN (SELECT 'Order #' || external_id FROM orders WHERE id = af.entity_id)
        WHEN 'company' THEN (SELECT name FROM companies WHERE id = af.entity_id)
        WHEN 'product' THEN (SELECT coalesce(name, sku_prefix) FROM catalog_products WHERE id = af.entity_id)
        WHEN 'customer' THEN (SELECT name FROM companies WHERE id = af.entity_id)
        WHEN 'inventory' THEN (SELECT sku FROM catalog_skus WHERE id = af.entity_id)
        WHEN 'po' THEN (SELECT po_number FROM purchase_orders WHERE id = af.entity_id)
        WHEN 'payment' THEN (SELECT 'Payment' || CASE WHEN entity_id IS NOT NULL THEN ' #' || substr(af.entity_id, 1, 8) ELSE '' END)
      END as entity_name,
      CASE af.entity_type
        WHEN 'deal' THEN '/pipeline/' || af.entity_id
        WHEN 'order' THEN '/orders/' || af.entity_id
        WHEN 'company' THEN '/prospects/' || af.entity_id
        WHEN 'product' THEN '/catalog/' || (SELECT sku_prefix FROM catalog_products WHERE id = af.entity_id)
        WHEN 'customer' THEN '/customers'
        WHEN 'inventory' THEN '/inventory'
        WHEN 'po' THEN '/inventory/purchase-orders'
        ELSE NULL
      END as entity_href
    FROM activity_feed af
    ORDER BY af.created_at DESC
    LIMIT 20
  `).all();

  return NextResponse.json({
    totalProspects,
    outreachReady,
    pipelineValue: activeDeals.total,
    activeDeals: activeDeals.c,
    icpABCount,
    unscoredCount,
    pendingOrders,
    totalRevenue,
    inventoryUnits: inventoryStats.totalUnits,
    inventorySkus: inventoryStats.skuCount,
    inventoryValue,
    revenueByChannel,
    unreadNotifications,
    lowStockAlerts,
    recentActivity,
  });
}
