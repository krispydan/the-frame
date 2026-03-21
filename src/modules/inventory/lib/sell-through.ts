/**
 * Sell-through velocity and reorder calculations.
 * 
 * Calculates:
 * - Sell-through rate: units sold per week (from order_items over configurable window)
 * - Days of stock remaining: current_stock / daily_sell_through
 * - Reorder date: today + days_of_stock - (production_lead + transit_lead)
 * - Needs reorder flag: when reorder_date <= today + 7 days
 */

import { db, sqlite } from "@/lib/db";
import { sql } from "drizzle-orm";

export type SellThroughResult = {
  skuId: string;
  sku: string;
  productName: string;
  colorName: string;
  factoryCode: string;
  currentStock: number;
  reservedStock: number;
  availableStock: number;
  sellThroughWeekly: number;
  sellThroughDaily: number;
  daysOfStock: number;
  reorderDate: string | null;
  needsReorder: boolean;
  productionLeadDays: number;
  transitLeadDays: number;
  totalLeadDays: number;
  velocity: "fast" | "normal" | "slow" | "dead";
};

/**
 * Calculate sell-through from actual order data over a window.
 */
export function calculateSellThrough(windowDays: number = 30): SellThroughResult[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffStr = cutoff.toISOString();

  // Get units sold per SKU in the window
  const soldData = db.all(sql`
    SELECT
      oi.sku_id,
      SUM(oi.quantity) as total_sold
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    WHERE o.placed_at >= ${cutoffStr}
      AND o.status NOT IN ('cancelled', 'returned')
    GROUP BY oi.sku_id
  `) as Array<{ sku_id: string; total_sold: number }>;

  const soldMap = new Map<string, number>();
  for (const row of soldData) {
    soldMap.set(row.sku_id, row.total_sold);
  }

  // Get all inventory with factory info
  const items = db.all(sql`
    SELECT
      i.id as inv_id,
      i.sku_id,
      i.quantity,
      i.reserved_quantity,
      i.sell_through_weekly as current_sell_through,
      s.sku,
      s.color_name,
      p.name as product_name,
      p.sku_prefix,
      f.code as factory_code,
      f.production_lead_days,
      f.transit_lead_days
    FROM inventory i
    JOIN catalog_skus s ON i.sku_id = s.id
    JOIN catalog_products p ON s.product_id = p.id
    LEFT JOIN inventory_factories f ON f.code = SUBSTR(s.sku, 1, 3)
    WHERE i.location = 'warehouse'
  `) as Array<Record<string, unknown>>;

  const weeks = windowDays / 7;
  const results: SellThroughResult[] = [];

  const updateStmt = sqlite.prepare(`
    UPDATE inventory
    SET sell_through_weekly = ?, days_of_stock = ?, reorder_date = ?, needs_reorder = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  const updateMany = sqlite.transaction((updates: Array<{ id: string; stw: number; dos: number; rd: string | null; nr: number }>) => {
    for (const u of updates) {
      updateStmt.run(u.stw, u.dos, u.rd, u.nr, u.id);
    }
  });

  const updates: Array<{ id: string; stw: number; dos: number; rd: string | null; nr: number }> = [];

  for (const item of items) {
    const skuId = item.sku_id as string;
    const qty = item.quantity as number;
    const reserved = item.reserved_quantity as number;
    const available = qty - reserved;
    const unitsSold = soldMap.get(skuId) || 0;
    
    // If no actual sales data, use existing sell_through (from seed)
    let weeklyRate = unitsSold > 0 ? Math.round((unitsSold / weeks) * 10) / 10 : (item.current_sell_through as number) || 0;
    
    const dailyRate = weeklyRate / 7;
    const daysOfStock = dailyRate > 0 ? Math.round((available / dailyRate) * 10) / 10 : 9999;

    const prodLead = (item.production_lead_days as number) || 30;
    const transitLead = (item.transit_lead_days as number) || 25;
    const totalLead = prodLead + transitLead;

    let reorderDate: string | null = null;
    let needsReorder = false;

    if (dailyRate > 0) {
      const stockRunoutDays = available / dailyRate;
      const reorderDaysFromNow = stockRunoutDays - totalLead;
      const rd = new Date();
      rd.setDate(rd.getDate() + Math.floor(reorderDaysFromNow));
      reorderDate = rd.toISOString().split("T")[0];

      // Needs reorder if reorder date is within 7 days
      needsReorder = reorderDaysFromNow <= 7;
    }

    // Velocity classification
    let velocity: "fast" | "normal" | "slow" | "dead" = "dead";
    if (weeklyRate >= 10) velocity = "fast";
    else if (weeklyRate >= 3) velocity = "normal";
    else if (weeklyRate >= 0.5) velocity = "slow";

    results.push({
      skuId,
      sku: item.sku as string,
      productName: item.product_name as string,
      colorName: item.color_name as string,
      factoryCode: item.factory_code as string || "?",
      currentStock: qty,
      reservedStock: reserved,
      availableStock: available,
      sellThroughWeekly: weeklyRate,
      sellThroughDaily: Math.round(dailyRate * 10) / 10,
      daysOfStock,
      reorderDate,
      needsReorder,
      productionLeadDays: prodLead,
      transitLeadDays: transitLead,
      totalLeadDays: totalLead,
      velocity,
    });

    updates.push({
      id: item.inv_id as string,
      stw: weeklyRate,
      dos: daysOfStock,
      rd: reorderDate,
      nr: needsReorder ? 1 : 0,
    });
  }

  // Batch update inventory records
  updateMany(updates);

  return results;
}

/**
 * Get reorder recommendations — SKUs that need to be reordered now.
 */
export function getReorderRecommendations(targetStockDays: number = 90): Array<SellThroughResult & { recommendedQty: number; urgencyLevel: "critical" | "urgent" | "normal" }> {
  const all = calculateSellThrough(30);
  
  return all
    .filter((item) => item.needsReorder || item.currentStock === 0)
    .map((item) => {
      const dailyRate = item.sellThroughDaily;
      const recommendedQty = dailyRate > 0
        ? Math.max(Math.ceil(dailyRate * targetStockDays), 100)
        : 100; // Minimum order

      let urgencyLevel: "critical" | "urgent" | "normal" = "normal";
      if (item.currentStock === 0) urgencyLevel = "critical";
      else if (item.daysOfStock < 14) urgencyLevel = "critical";
      else if (item.daysOfStock < 30) urgencyLevel = "urgent";

      return { ...item, recommendedQty, urgencyLevel };
    })
    .sort((a, b) => {
      const urgencyOrder = { critical: 0, urgent: 1, normal: 2 };
      return urgencyOrder[a.urgencyLevel] - urgencyOrder[b.urgencyLevel] || a.daysOfStock - b.daysOfStock;
    });
}
