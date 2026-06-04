/**
 * Trend Detector Agent
 * Analyzes order data to detect emerging/declining product trends,
 * seasonal patterns, and momentum scores.
 */

import { sqlite } from "@/lib/db";

export interface ProductTrend {
  sku: string;
  skuId: string | null;
  productName: string;
  colorName: string | null;
  currentPeriodUnits: number;
  priorPeriodUnits: number;
  currentPeriodRevenue: number;
  priorPeriodRevenue: number;
  growthRate: number; // percentage
  momentumScore: number; // -100 to 100
  direction: "up" | "down" | "flat";
}

export interface ChannelTrend {
  channel: string;
  currentPeriodOrders: number;
  priorPeriodOrders: number;
  currentPeriodRevenue: number;
  priorPeriodRevenue: number;
  growthRate: number;
}

export interface SeasonalPattern {
  month: number;
  monthName: string;
  avgOrders: number;
  avgRevenue: number;
}

export interface TrendData {
  trending_up: ProductTrend[];
  trending_down: ProductTrend[];
  flat: ProductTrend[];
  dead_stock: { sku: string; name: string; days_since_sale: number }[];
  channel_trends: ChannelTrend[];
  seasonal_patterns: SeasonalPattern[];
  periodDays: number;
  generatedAt: string;
}

/**
 * Detect trends by comparing current period vs prior period.
 * @param periodDays Number of days per period (default 30)
 */
export function detectTrends(periodDays = 30): TrendData {
  const now = new Date();
  const currentStart = new Date(now.getTime() - periodDays * 86400000);
  const priorStart = new Date(currentStart.getTime() - periodDays * 86400000);

  const currentStartStr = currentStart.toISOString().slice(0, 10);
  const priorStartStr = priorStart.toISOString().slice(0, 10);

  // ── Product trends: compare current vs prior period per SKU ──
  const productData = sqlite.prepare(`
    SELECT
      oi.sku,
      oi.sku_id,
      oi.product_name,
      oi.color_name,
      COALESCE(SUM(CASE WHEN o.placed_at >= ? THEN oi.quantity ELSE 0 END), 0) AS current_units,
      COALESCE(SUM(CASE WHEN o.placed_at >= ? AND o.placed_at < ? THEN oi.quantity ELSE 0 END), 0) AS prior_units,
      COALESCE(SUM(CASE WHEN o.placed_at >= ? THEN oi.total_price ELSE 0 END), 0) AS current_revenue,
      COALESCE(SUM(CASE WHEN o.placed_at >= ? AND o.placed_at < ? THEN oi.total_price ELSE 0 END), 0) AS prior_revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.placed_at >= ?
      AND o.status NOT IN ('cancelled', 'returned')
    GROUP BY oi.sku
    ORDER BY current_units DESC
  `).all(
    currentStartStr,
    priorStartStr, currentStartStr,
    currentStartStr,
    priorStartStr, currentStartStr,
    priorStartStr,
  ) as Array<{
    sku: string;
    sku_id: string | null;
    product_name: string;
    color_name: string | null;
    current_units: number;
    prior_units: number;
    current_revenue: number;
    prior_revenue: number;
  }>;

  const allTrends: ProductTrend[] = productData.map((row) => {
    const growthRate = row.prior_units > 0
      ? ((row.current_units - row.prior_units) / row.prior_units) * 100
      : row.current_units > 0 ? 100 : 0;

    // Momentum: weighted score factoring volume + growth
    const volumeWeight = Math.min(row.current_units / 10, 1); // normalize to max ~10 units
    const momentumScore = Math.round(Math.max(-100, Math.min(100, growthRate * volumeWeight)));

    const direction: "up" | "down" | "flat" =
      growthRate > 5 ? "up" : growthRate < -5 ? "down" : "flat";

    return {
      sku: row.sku || "unknown",
      skuId: row.sku_id,
      productName: row.product_name,
      colorName: row.color_name,
      currentPeriodUnits: row.current_units,
      priorPeriodUnits: row.prior_units,
      currentPeriodRevenue: row.current_revenue,
      priorPeriodRevenue: row.prior_revenue,
      growthRate: Math.round(growthRate * 10) / 10,
      momentumScore,
      direction,
    };
  });

  const trending_up = allTrends.filter((t) => t.direction === "up").sort((a, b) => b.growthRate - a.growthRate);
  const trending_down = allTrends.filter((t) => t.direction === "down").sort((a, b) => a.growthRate - b.growthRate);
  const flat = allTrends.filter((t) => t.direction === "flat");

  // ── Dead stock: SKUs with no sales in the period ──
  const deadStockData = sqlite.prepare(`
    SELECT
      oi.sku,
      oi.product_name,
      CAST(julianday('now') - julianday(MAX(o.placed_at)) AS INTEGER) AS days_since
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status NOT IN ('cancelled', 'returned')
    GROUP BY oi.sku
    HAVING days_since > ?
    ORDER BY days_since DESC
  `).all(periodDays) as Array<{ sku: string; product_name: string; days_since: number }>;

  const dead_stock = deadStockData.map((r) => ({
    sku: r.sku || "unknown",
    name: r.product_name,
    days_since_sale: r.days_since,
  }));

  // ── Channel trends ──
  const channelData = sqlite.prepare(`
    SELECT
      channel,
      COALESCE(SUM(CASE WHEN placed_at >= ? THEN 1 ELSE 0 END), 0) AS current_orders,
      COALESCE(SUM(CASE WHEN placed_at >= ? AND placed_at < ? THEN 1 ELSE 0 END), 0) AS prior_orders,
      COALESCE(SUM(CASE WHEN placed_at >= ? THEN total ELSE 0 END), 0) AS current_revenue,
      COALESCE(SUM(CASE WHEN placed_at >= ? AND placed_at < ? THEN total ELSE 0 END), 0) AS prior_revenue
    FROM orders
    WHERE placed_at >= ?
      AND status NOT IN ('cancelled', 'returned')
    GROUP BY channel
  `).all(
    currentStartStr,
    priorStartStr, currentStartStr,
    currentStartStr,
    priorStartStr, currentStartStr,
    priorStartStr,
  ) as Array<{
    channel: string;
    current_orders: number;
    prior_orders: number;
    current_revenue: number;
    prior_revenue: number;
  }>;

  const channel_trends: ChannelTrend[] = channelData.map((r) => ({
    channel: r.channel,
    currentPeriodOrders: r.current_orders,
    priorPeriodOrders: r.prior_orders,
    currentPeriodRevenue: r.current_revenue,
    priorPeriodRevenue: r.prior_revenue,
    growthRate: r.prior_orders > 0
      ? Math.round(((r.current_orders - r.prior_orders) / r.prior_orders) * 1000) / 10
      : r.current_orders > 0 ? 100 : 0,
  }));

  // ── Seasonal patterns (monthly averages from all history) ──
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const seasonalData = sqlite.prepare(`
    SELECT
      CAST(strftime('%m', placed_at) AS INTEGER) AS month,
      CAST(COUNT(*) AS REAL) / MAX(1, COUNT(DISTINCT strftime('%Y', placed_at))) AS avg_orders,
      CAST(SUM(total) AS REAL) / MAX(1, COUNT(DISTINCT strftime('%Y', placed_at))) AS avg_revenue
    FROM orders
    WHERE status NOT IN ('cancelled', 'returned')
      AND placed_at IS NOT NULL
    GROUP BY month
    ORDER BY month
  `).all() as Array<{ month: number; avg_orders: number; avg_revenue: number }>;

  const seasonal_patterns: SeasonalPattern[] = seasonalData.map((r) => ({
    month: r.month,
    monthName: monthNames[r.month - 1] || `M${r.month}`,
    avgOrders: Math.round(r.avg_orders),
    avgRevenue: Math.round(r.avg_revenue),
  }));

  return {
    trending_up,
    trending_down,
    flat,
    dead_stock,
    channel_trends,
    seasonal_patterns,
    periodDays,
    generatedAt: now.toISOString(),
  };
}
