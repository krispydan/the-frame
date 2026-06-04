/**
 * Automated Report Generator
 * Creates weekly/monthly business summary reports from real data,
 * stores them in reporting_logs for history.
 */

import { sqlite } from "@/lib/db";
import { calculateBusinessHealth } from "../lib/business-health";

export interface ReportData {
  id: string;
  period: "weekly" | "monthly";
  dateRange: { from: string; to: string };
  revenue: { total: number; priorTotal: number; changePercent: number };
  orders: { count: number; priorCount: number; avgOrderValue: number };
  topProducts: { sku: string; name: string; units: number; revenue: number }[];
  channelBreakdown: { channel: string; orders: number; revenue: number; percent: number }[];
  healthScore: number;
  healthStatus: string;
  generatedAt: string;
  markdown: string;
}

function fmt(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

function pct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

export function generateReport(period: "weekly" | "monthly" = "weekly"): ReportData {
  const days = period === "weekly" ? 7 : 30;
  const now = new Date();
  const currentStart = new Date(now.getTime() - days * 86400000);
  const priorStart = new Date(currentStart.getTime() - days * 86400000);

  const nowStr = now.toISOString().slice(0, 10);
  const currentStartStr = currentStart.toISOString().slice(0, 10);
  const priorStartStr = priorStart.toISOString().slice(0, 10);

  // ── Revenue & order counts ──
  const revData = sqlite.prepare(`
    SELECT
      CASE WHEN placed_at >= ? THEN 'current' ELSE 'prior' END AS period_label,
      COALESCE(SUM(total), 0) AS total_revenue,
      COUNT(*) AS order_count
    FROM orders
    WHERE placed_at >= ?
      AND status NOT IN ('cancelled', 'returned')
    GROUP BY period_label
  `).all(currentStartStr, priorStartStr) as Array<{
    period_label: string; total_revenue: number; order_count: number;
  }>;

  const current = revData.find((r) => r.period_label === "current") || { total_revenue: 0, order_count: 0 };
  const prior = revData.find((r) => r.period_label === "prior") || { total_revenue: 0, order_count: 0 };

  const revenueChange = prior.total_revenue > 0
    ? ((current.total_revenue - prior.total_revenue) / prior.total_revenue) * 100
    : current.total_revenue > 0 ? 100 : 0;

  // ── Top products ──
  const topProducts = sqlite.prepare(`
    SELECT
      oi.sku,
      oi.product_name,
      SUM(oi.quantity) AS units,
      SUM(oi.total_price) AS revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.placed_at >= ?
      AND o.status NOT IN ('cancelled', 'returned')
    GROUP BY oi.sku
    ORDER BY revenue DESC
    LIMIT 10
  `).all(currentStartStr) as Array<{
    sku: string; product_name: string; units: number; revenue: number;
  }>;

  // ── Channel breakdown ──
  const channelData = sqlite.prepare(`
    SELECT
      channel,
      COUNT(*) AS orders,
      COALESCE(SUM(total), 0) AS revenue
    FROM orders
    WHERE placed_at >= ?
      AND status NOT IN ('cancelled', 'returned')
    GROUP BY channel
    ORDER BY revenue DESC
  `).all(currentStartStr) as Array<{ channel: string; orders: number; revenue: number }>;

  const totalRevenue = current.total_revenue || 1;
  const channelBreakdown = channelData.map((c) => ({
    channel: c.channel,
    orders: c.orders,
    revenue: c.revenue,
    percent: Math.round((c.revenue / totalRevenue) * 1000) / 10,
  }));

  // ── Health score ──
  const health = calculateBusinessHealth();

  // ── Build markdown report ──
  const channelLabel = (ch: string) => {
    const map: Record<string, string> = {
      shopify_dtc: "Shopify DTC",
      shopify_wholesale: "Shopify Wholesale",
      faire: "Faire",
      direct: "Direct",
      phone: "Phone",
    };
    return map[ch] || ch;
  };

  const markdown = `# ${period === "weekly" ? "Weekly" : "Monthly"} Business Report
*${currentStartStr} — ${nowStr}*

## Business Health: ${health.overall}/100 (${health.status})

## Revenue
- **This period:** ${fmt(current.total_revenue)}
- **Prior period:** ${fmt(prior.total_revenue)}
- **Change:** ${pct(revenueChange)}

## Orders
- **Count:** ${current.order_count} (prior: ${prior.order_count})
- **Avg order value:** ${fmt(current.order_count > 0 ? current.total_revenue / current.order_count : 0)}

## Top Products
${topProducts.map((p, i) => `${i + 1}. **${p.product_name}** (${p.sku}) — ${p.units} units, ${fmt(p.revenue)}`).join("\n")}

## Channel Performance
${channelBreakdown.map((c) => `- **${channelLabel(c.channel)}:** ${c.orders} orders, ${fmt(c.revenue)} (${c.percent}%)`).join("\n")}

## Health Components
- Pipeline: ${health.components.pipeline.score}/100 — ${health.components.pipeline.label}
- Inventory: ${health.components.inventory.score}/100 — ${health.components.inventory.label}
- Customers: ${health.components.customers.score}/100 — ${health.components.customers.label}
- Finance: ${health.components.finance.score}/100 — ${health.components.finance.label}

---
*Generated by The Frame AI — ${now.toISOString()}*`;

  // ── Store in reporting_logs ──
  const reportId = crypto.randomUUID();
  const reportData: ReportData = {
    id: reportId,
    period,
    dateRange: { from: currentStartStr, to: nowStr },
    revenue: { total: current.total_revenue, priorTotal: prior.total_revenue, changePercent: Math.round(revenueChange * 10) / 10 },
    orders: {
      count: current.order_count,
      priorCount: prior.order_count,
      avgOrderValue: current.order_count > 0 ? Math.round(current.total_revenue / current.order_count) : 0,
    },
    topProducts: topProducts.map((p) => ({ sku: p.sku || "", name: p.product_name, units: p.units, revenue: p.revenue })),
    channelBreakdown,
    healthScore: health.overall,
    healthStatus: health.status,
    generatedAt: now.toISOString(),
    markdown,
  };

  // reporting_logs column is `timestamp`, not `created_at` — see
  // src/modules/core/schema/index.ts:reportingLogs.
  sqlite.prepare(`
    INSERT INTO reporting_logs (id, timestamp, event_type, module, metadata)
    VALUES (?, datetime('now'), ?, 'intelligence', ?)
  `).run(reportId, `${period}_report`, JSON.stringify(reportData));

  return reportData;
}

/**
 * Get previously generated reports from history.
 */
export function getReportHistory(limit = 10): ReportData[] {
  const rows = sqlite.prepare(`
    SELECT metadata FROM reporting_logs
    WHERE event_type IN ('weekly_report', 'monthly_report')
      AND module = 'intelligence'
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(limit) as Array<{ metadata: string }>;

  return rows.map((r) => {
    try {
      return typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata;
    } catch {
      return null;
    }
  }).filter(Boolean) as ReportData[];
}
