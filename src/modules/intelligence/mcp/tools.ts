/**
 * Intelligence Module MCP Tools
 */
import type { McpTool } from "@/modules/core/mcp/server";
import { detectTrends } from "../agents/trend-detector";
import { calculateBusinessHealth } from "../lib/business-health";
import { generateReport, getReportHistory } from "../agents/report-generator";

export const intelligenceMcpTools: McpTool[] = [
  {
    name: "intelligence.get_sell_through",
    description: "Get sell-through velocity data for all SKUs",
    inputSchema: { type: "object", properties: { period: { type: "string", enum: ["30d", "60d", "90d"] } } },
    handler: async () => {
      const { sqlite } = await import("@/lib/db");
      const rows = sqlite.prepare(`
        SELECT s.sku, s.color_name, p.name as product_name,
               i.quantity, i.sell_through_weekly, i.days_of_stock, i.needs_reorder,
               CASE
                 WHEN i.sell_through_weekly >= 10 THEN 'fast'
                 WHEN i.sell_through_weekly >= 3 THEN 'normal'
                 WHEN i.sell_through_weekly >= 0.5 THEN 'slow'
                 ELSE 'dead'
               END as velocity
        FROM inventory i
        JOIN catalog_skus s ON i.sku_id = s.id
        JOIN catalog_products p ON s.product_id = p.id
        ORDER BY i.sell_through_weekly DESC LIMIT 50
      `).all();
      const summary = sqlite.prepare(`
        SELECT COUNT(*) as total,
          SUM(CASE WHEN sell_through_weekly >= 10 THEN 1 ELSE 0 END) as fast,
          SUM(CASE WHEN sell_through_weekly >= 3 AND sell_through_weekly < 10 THEN 1 ELSE 0 END) as normal,
          SUM(CASE WHEN sell_through_weekly >= 0.5 AND sell_through_weekly < 3 THEN 1 ELSE 0 END) as slow,
          SUM(CASE WHEN sell_through_weekly < 0.5 THEN 1 ELSE 0 END) as dead
        FROM inventory
      `).get();
      return { content: [{ type: "text", text: JSON.stringify({ summary, items: rows }, null, 2) }] };
    },
  },
  {
    name: "intelligence.get_trends",
    description: "Get product trend data — trending up, down, dead stock, channel trends",
    inputSchema: {
      type: "object",
      properties: { periodDays: { type: "number", description: "Days per period (default 30)" } },
    },
    handler: async (args: any) => {
      const trends = detectTrends(args?.periodDays || 30);
      return { content: [{ type: "text", text: JSON.stringify(trends, null, 2) }] };
    },
  },
  {
    name: "intelligence.get_pricing",
    description: "Get pricing and margin analysis for all products",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const { sqlite } = await import("@/lib/db");
      const rows = sqlite.prepare(`
        SELECT p.name, p.sku_prefix, p.wholesale_price, p.retail_price, p.msrp,
               s.sku, s.cost_price, s.color_name,
               CASE WHEN s.cost_price > 0 AND p.wholesale_price > 0
                 THEN ROUND((p.wholesale_price - s.cost_price) / p.wholesale_price * 100, 1)
                 ELSE NULL END as wholesale_margin_pct,
               CASE WHEN s.cost_price > 0 AND p.retail_price > 0
                 THEN ROUND((p.retail_price - s.cost_price) / p.retail_price * 100, 1)
                 ELSE NULL END as retail_margin_pct
        FROM catalog_products p
        JOIN catalog_skus s ON s.product_id = p.id
        ORDER BY p.sku_prefix, s.sku
      `).all();
      const avgWholesaleMargin = sqlite.prepare(`
        SELECT ROUND(AVG((p.wholesale_price - s.cost_price) / p.wholesale_price * 100), 1) as avg_margin
        FROM catalog_products p JOIN catalog_skus s ON s.product_id = p.id
        WHERE s.cost_price > 0 AND p.wholesale_price > 0
      `).get();
      return { content: [{ type: "text", text: JSON.stringify({ summary: avgWholesaleMargin, items: rows }, null, 2) }] };
    },
  },
  {
    name: "intelligence.get_business_health",
    description: "Get composite business health score with component breakdown",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const health = calculateBusinessHealth();
      return { content: [{ type: "text", text: JSON.stringify(health, null, 2) }] };
    },
  },
  {
    name: "intelligence.generate_report",
    description: "Generate a weekly or monthly business summary report",
    inputSchema: {
      type: "object",
      properties: { period: { type: "string", enum: ["weekly", "monthly"] } },
    },
    handler: async (args: any) => {
      const report = generateReport(args?.period || "weekly");
      return { content: [{ type: "text", text: report.markdown }] };
    },
  },
  {
    name: "intelligence.get_report_history",
    description: "Get previously generated reports",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max reports to return (default 10)" } },
    },
    handler: async (args: any) => {
      const reports = getReportHistory(args?.limit || 10);
      return { content: [{ type: "text", text: JSON.stringify(reports, null, 2) }] };
    },
  },
  {
    name: "intelligence.get_geo_analysis",
    description: "Get geographic analysis — prospects, orders, revenue by state",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      return { content: [{ type: "text", text: "Geographic analysis — wire to real sales + orders modules" }] };
    },
  },
];
