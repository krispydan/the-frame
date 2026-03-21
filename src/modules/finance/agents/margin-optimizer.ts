/**
 * AI Margin Optimizer (Phase 7 — rule-based)
 * 
 * Analyzes margins by product and channel.
 * Flags low-margin items and suggests optimizations.
 */

import { sqlite } from "@/lib/db";

export interface MarginAnalysis {
  product: string;
  sku: string;
  channel: string;
  channelLabel: string;
  unitPrice: number;
  landedCost: number;
  channelFees: number;
  netMargin: number;
  netMarginPct: number;
  unitsSold: number;
  totalProfit: number;
  flag: "healthy" | "watch" | "low" | "negative";
  suggestion: string;
}

const CHANNEL_FEE_RATES: Record<string, number> = {
  shopify_dtc: 0.029,       // 2.9% payment processing
  shopify_wholesale: 0.015,  // 1.5% lower rate for B2B
  faire: 0.25,               // 25% first order commission
  amazon: 0.15,              // ~15% referral + FBA
};

const CHANNEL_LABELS: Record<string, string> = {
  shopify_dtc: "Shopify DTC",
  shopify_wholesale: "Shopify Wholesale",
  faire: "Faire",
  amazon: "Amazon",
};

export function analyzeMargins(): {
  items: MarginAnalysis[];
  summary: {
    totalProducts: number;
    healthyCount: number;
    watchCount: number;
    lowCount: number;
    negativeCount: number;
    avgMarginPct: number;
    recommendations: string[];
  };
} {
  // Get product sales with costs by channel
  const data = sqlite.prepare(`
    SELECT 
      p.name as product,
      s.sku,
      o.channel,
      AVG(oi.unit_price) as avg_unit_price,
      SUM(oi.quantity) as units_sold,
      SUM(oi.total_price) as total_revenue,
      COALESCE(
        (SELECT lc.landed_cost_per_unit FROM inventory_landed_costs lc WHERE lc.sku_id = s.id LIMIT 1),
        0
      ) as landed_cost
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    LEFT JOIN catalog_skus s ON oi.sku_id = s.id
    LEFT JOIN catalog_products p ON s.product_id = p.id
    WHERE o.status NOT IN ('cancelled', 'returned')
    GROUP BY s.id, o.channel
    HAVING units_sold > 0
    ORDER BY total_revenue DESC
  `).all() as Array<{
    product: string;
    sku: string;
    channel: string;
    avg_unit_price: number;
    units_sold: number;
    total_revenue: number;
    landed_cost: number;
  }>;

  const items: MarginAnalysis[] = data.map((row) => {
    const feeRate = CHANNEL_FEE_RATES[row.channel] || 0.03;
    const channelFees = row.avg_unit_price * feeRate;
    const netMargin = row.avg_unit_price - row.landed_cost - channelFees;
    const netMarginPct = row.avg_unit_price > 0 ? (netMargin / row.avg_unit_price) * 100 : 0;
    const totalProfit = netMargin * row.units_sold;

    let flag: MarginAnalysis["flag"];
    let suggestion: string;

    if (netMarginPct < 0) {
      flag = "negative";
      suggestion = `Losing ${Math.abs(netMarginPct).toFixed(0)}% per unit on ${row.channel}. Consider removing from this channel or increasing price.`;
    } else if (netMarginPct < 20) {
      flag = "low";
      suggestion = `Margin below 20%. Consider price increase, cost reduction, or dropping from ${CHANNEL_LABELS[row.channel]}.`;
    } else if (netMarginPct < 40) {
      flag = "watch";
      suggestion = `Margin is OK but could improve. Look for bulk shipping or production cost savings.`;
    } else {
      flag = "healthy";
      suggestion = "Good margins. Consider increasing volume on this channel.";
    }

    return {
      product: row.product || "Unknown",
      sku: row.sku || "Unknown",
      channel: row.channel,
      channelLabel: CHANNEL_LABELS[row.channel] || row.channel,
      unitPrice: Math.round(row.avg_unit_price * 100) / 100,
      landedCost: Math.round(row.landed_cost * 100) / 100,
      channelFees: Math.round(channelFees * 100) / 100,
      netMargin: Math.round(netMargin * 100) / 100,
      netMarginPct: Math.round(netMarginPct * 10) / 10,
      unitsSold: row.units_sold,
      totalProfit: Math.round(totalProfit * 100) / 100,
      flag,
      suggestion,
    };
  });

  const healthyCount = items.filter((i) => i.flag === "healthy").length;
  const watchCount = items.filter((i) => i.flag === "watch").length;
  const lowCount = items.filter((i) => i.flag === "low").length;
  const negativeCount = items.filter((i) => i.flag === "negative").length;
  const avgMarginPct = items.length > 0
    ? items.reduce((s, i) => s + i.netMarginPct, 0) / items.length
    : 0;

  // Generate top recommendations
  const recommendations: string[] = [];
  if (negativeCount > 0) {
    recommendations.push(`🚨 ${negativeCount} product-channel combinations have negative margins — review immediately.`);
  }
  if (lowCount > 0) {
    recommendations.push(`⚠️ ${lowCount} items below 20% margin — consider price increases or cost optimization.`);
  }

  const faireItems = items.filter((i) => i.channel === "faire");
  if (faireItems.length > 0) {
    const avgFaireMargin = faireItems.reduce((s, i) => s + i.netMarginPct, 0) / faireItems.length;
    if (avgFaireMargin < 30) {
      recommendations.push(`Faire average margin is ${avgFaireMargin.toFixed(0)}%. The 25% commission significantly impacts margins — ensure wholesale pricing covers this.`);
    }
  }

  const topProfitItems = [...items].sort((a, b) => b.totalProfit - a.totalProfit).slice(0, 3);
  if (topProfitItems.length > 0) {
    recommendations.push(`💰 Top profit drivers: ${topProfitItems.map((i) => `${i.sku} on ${i.channelLabel}`).join(", ")}. Focus marketing here.`);
  }

  return {
    items,
    summary: {
      totalProducts: items.length,
      healthyCount,
      watchCount,
      lowCount,
      negativeCount,
      avgMarginPct: Math.round(avgMarginPct * 10) / 10,
      recommendations,
    },
  };
}
