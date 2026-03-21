/**
 * AI Demand Forecaster (Phase 6 — rule-based)
 * 
 * - Linear projection from 30/60/90 day sell-through windows
 * - Seasonal adjustment placeholder
 * - Suggests reorder quantities based on target stock days
 * - Runs weekly as background job
 */

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

export type ForecastResult = {
  skuId: string;
  sku: string;
  productName: string;
  colorName: string;
  factoryCode: string;
  currentStock: number;
  // Sell-through windows
  sellThrough30d: number; // units/week from last 30 days
  sellThrough60d: number;
  sellThrough90d: number;
  // Trend
  trendDirection: "accelerating" | "stable" | "decelerating";
  projectedWeeklyRate: number;
  // Forecast
  projectedStockoutDate: string | null;
  daysUntilStockout: number;
  // Recommendation
  recommendedReorderQty: number;
  targetStockDays: number;
  urgencyLevel: "critical" | "urgent" | "watch" | "ok";
  // Seasonal (placeholder)
  seasonalFactor: number; // 1.0 = no adjustment
  notes: string;
};

// Seasonal adjustment factors by month (placeholder — needs real data)
const SEASONAL_FACTORS: Record<number, number> = {
  1: 0.7,   // Jan — post-holiday slow
  2: 0.75,  // Feb
  3: 0.9,   // Mar — spring pickup
  4: 1.1,   // Apr — spring peak
  5: 1.3,   // May — summer prep
  6: 1.4,   // Jun — peak sunglasses
  7: 1.5,   // Jul — peak
  8: 1.3,   // Aug — still strong
  9: 1.0,   // Sep — back to school
  10: 0.8,  // Oct
  11: 0.9,  // Nov — holiday gifting starts
  12: 1.1,  // Dec — holiday
};

function getSellThroughForWindow(windowDays: number): Map<string, number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffStr = cutoff.toISOString();
  const weeks = windowDays / 7;

  const rows = db.all(sql`
    SELECT oi.sku_id, SUM(oi.quantity) as total_sold
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    WHERE o.placed_at >= ${cutoffStr}
      AND o.status NOT IN ('cancelled', 'returned')
    GROUP BY oi.sku_id
  `) as Array<{ sku_id: string; total_sold: number }>;

  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.sku_id, Math.round((row.total_sold / weeks) * 10) / 10);
  }
  return map;
}

export function runDemandForecast(targetStockDays: number = 90): ForecastResult[] {
  // Get sell-through for 3 windows
  const st30 = getSellThroughForWindow(30);
  const st60 = getSellThroughForWindow(60);
  const st90 = getSellThroughForWindow(90);

  const currentMonth = new Date().getMonth() + 1;
  const seasonalFactor = SEASONAL_FACTORS[currentMonth] || 1.0;

  // Get inventory + factory data
  const items = db.all(sql`
    SELECT
      i.sku_id,
      i.quantity,
      i.sell_through_weekly,
      s.sku,
      s.color_name,
      p.name as product_name,
      f.code as factory_code,
      f.production_lead_days,
      f.transit_lead_days
    FROM inventory i
    JOIN catalog_skus s ON i.sku_id = s.id
    JOIN catalog_products p ON s.product_id = p.id
    LEFT JOIN inventory_factories f ON f.code = SUBSTR(s.sku, 1, 3)
    WHERE i.location = 'warehouse'
  `) as Array<Record<string, unknown>>;

  const results: ForecastResult[] = [];

  for (const item of items) {
    const skuId = item.sku_id as string;
    const qty = item.quantity as number;
    const seedRate = item.sell_through_weekly as number;

    // Use actual data if available, fall back to seed
    const rate30 = st30.get(skuId) ?? seedRate;
    const rate60 = st60.get(skuId) ?? seedRate;
    const rate90 = st90.get(skuId) ?? seedRate;

    // Trend: compare 30d vs 90d rate
    let trendDirection: "accelerating" | "stable" | "decelerating" = "stable";
    if (rate90 > 0) {
      const ratio = rate30 / rate90;
      if (ratio > 1.15) trendDirection = "accelerating";
      else if (ratio < 0.85) trendDirection = "decelerating";
    }

    // Projected rate: weighted average (recent data weighted more)
    const avgRate = rate30 > 0 || rate60 > 0 || rate90 > 0
      ? (rate30 * 3 + rate60 * 2 + rate90 * 1) / 6
      : seedRate;
    
    // Apply seasonal adjustment
    const projectedWeeklyRate = Math.round(avgRate * seasonalFactor * 10) / 10;
    const dailyRate = projectedWeeklyRate / 7;

    // Stockout projection
    const daysUntilStockout = dailyRate > 0 ? Math.round(qty / dailyRate) : 9999;
    let projectedStockoutDate: string | null = null;
    if (daysUntilStockout < 9999) {
      const d = new Date();
      d.setDate(d.getDate() + daysUntilStockout);
      projectedStockoutDate = d.toISOString().split("T")[0];
    }

    // Recommended reorder qty: target days of stock
    const recommendedReorderQty = dailyRate > 0
      ? Math.max(Math.ceil(dailyRate * targetStockDays), 100)
      : 0;

    // Urgency
    const leadDays = ((item.production_lead_days as number) || 30) + ((item.transit_lead_days as number) || 25);
    let urgencyLevel: "critical" | "urgent" | "watch" | "ok" = "ok";
    if (qty === 0) urgencyLevel = "critical";
    else if (daysUntilStockout <= leadDays) urgencyLevel = "critical";
    else if (daysUntilStockout <= leadDays + 14) urgencyLevel = "urgent";
    else if (daysUntilStockout <= leadDays + 30) urgencyLevel = "watch";

    let notes = "";
    if (trendDirection === "accelerating") notes = "📈 Sales accelerating — consider ordering more";
    else if (trendDirection === "decelerating") notes = "📉 Sales slowing — review order quantity";
    if (seasonalFactor > 1.2) notes += (notes ? ". " : "") + `🌞 Peak season (${Math.round(seasonalFactor * 100 - 100)}% uplift)`;
    if (seasonalFactor < 0.8) notes += (notes ? ". " : "") + `❄️ Low season (${Math.round(100 - seasonalFactor * 100)}% reduction)`;

    results.push({
      skuId,
      sku: item.sku as string,
      productName: item.product_name as string,
      colorName: item.color_name as string,
      factoryCode: item.factory_code as string || "?",
      currentStock: qty,
      sellThrough30d: rate30,
      sellThrough60d: rate60,
      sellThrough90d: rate90,
      trendDirection,
      projectedWeeklyRate,
      projectedStockoutDate,
      daysUntilStockout,
      recommendedReorderQty,
      targetStockDays,
      urgencyLevel,
      seasonalFactor,
      notes,
    });
  }

  // Sort by urgency then days until stockout
  const urgencyOrder = { critical: 0, urgent: 1, watch: 2, ok: 3 };
  results.sort((a, b) => urgencyOrder[a.urgencyLevel] - urgencyOrder[b.urgencyLevel] || a.daysUntilStockout - b.daysUntilStockout);

  return results;
}
