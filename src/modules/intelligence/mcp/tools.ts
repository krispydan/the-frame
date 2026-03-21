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
      return { content: [{ type: "text", text: "Sell-through data — wire to real inventory module" }] };
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
      return { content: [{ type: "text", text: "Pricing analysis — wire to real catalog + inventory modules" }] };
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
