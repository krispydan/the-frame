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

  const recentActivity = sqlite.prepare(
    "SELECT * FROM activity_feed ORDER BY created_at DESC LIMIT 20"
  ).all();

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
    recentActivity,
  });
}
