/**
 * P&L Calculation Engine
 * 
 * Calculates P&L from orders, settlements, expenses, and inventory costs.
 * Supports per-channel breakdown, time period filtering, and period comparison.
 */

import { sqlite } from "@/lib/db";

export type PnlPeriod = "mtd" | "last_month" | "qtd" | "ytd" | "custom";

export interface ChannelPnl {
  channel: string;
  channelLabel: string;
  revenue: number;
  cogs: number;
  grossMargin: number;
  grossMarginPct: number;
  fees: number;
  orderCount: number;
}

export interface PnlSummary {
  period: { start: string; end: string; label: string };
  revenue: number;
  cogs: number;
  grossMargin: number;
  grossMarginPct: number;
  totalFees: number;
  totalExpenses: number;
  netIncome: number;
  channels: ChannelPnl[];
  expensesByCategory: Array<{ category: string; amount: number; budget: number | null }>;
  comparison: PnlComparison | null;
}

export interface PnlComparison {
  priorPeriod: { start: string; end: string; label: string };
  revenue: number;
  cogs: number;
  grossMargin: number;
  totalExpenses: number;
  netIncome: number;
  revenueChange: number;
  cogsChange: number;
  grossMarginChange: number;
  expensesChange: number;
  netIncomeChange: number;
}

const CHANNEL_LABELS: Record<string, string> = {
  shopify_dtc: "Shopify DTC",
  shopify_wholesale: "Shopify Wholesale",
  faire: "Faire",
  amazon: "Amazon",
  direct: "Direct",
  phone: "Phone",
};

function getPeriodDates(period: PnlPeriod, customStart?: string, customEnd?: string): { start: string; end: string; label: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  switch (period) {
    case "mtd":
      return {
        start: `${year}-${String(month + 1).padStart(2, "0")}-01`,
        end: now.toISOString().split("T")[0],
        label: now.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      };
    case "last_month": {
      const lm = new Date(year, month - 1, 1);
      const lmEnd = new Date(year, month, 0);
      return {
        start: lm.toISOString().split("T")[0],
        end: lmEnd.toISOString().split("T")[0],
        label: lm.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      };
    }
    case "qtd": {
      const qStart = Math.floor(month / 3) * 3;
      return {
        start: `${year}-${String(qStart + 1).padStart(2, "0")}-01`,
        end: now.toISOString().split("T")[0],
        label: `Q${Math.floor(month / 3) + 1} ${year}`,
      };
    }
    case "ytd":
      return {
        start: `${year}-01-01`,
        end: now.toISOString().split("T")[0],
        label: `YTD ${year}`,
      };
    case "custom":
      return {
        start: customStart || `${year}-01-01`,
        end: customEnd || now.toISOString().split("T")[0],
        label: `${customStart} to ${customEnd}`,
      };
  }
}

/** Get a prior period of the same length for comparison */
function getPriorPeriodDates(start: string, end: string): { start: string; end: string; label: string } {
  const s = new Date(start);
  const e = new Date(end);
  const durationMs = e.getTime() - s.getTime();
  const priorEnd = new Date(s.getTime() - 86400000); // day before current start
  const priorStart = new Date(priorEnd.getTime() - durationMs);
  return {
    start: priorStart.toISOString().split("T")[0],
    end: priorEnd.toISOString().split("T")[0],
    label: `${priorStart.toISOString().split("T")[0]} to ${priorEnd.toISOString().split("T")[0]}`,
  };
}

function pctChange(current: number, prior: number): number {
  if (prior === 0) return current === 0 ? 0 : 100;
  return ((current - prior) / Math.abs(prior)) * 100;
}

function calculatePnlForRange(startDate: string, endDate: string): {
  revenue: number;
  cogs: number;
  grossMargin: number;
  totalFees: number;
  totalExpenses: number;
  netIncome: number;
  channels: ChannelPnl[];
  expensesByCategory: Array<{ category: string; amount: number; budget: number | null }>;
} {
  // Revenue + COGS by channel from orders
  // COGS: Use average unit cost from PO line items matched via SKU
  const channelData = sqlite.prepare(`
    SELECT 
      o.channel,
      COUNT(DISTINCT o.id) as order_count,
      COALESCE(SUM(o.total), 0) as revenue,
      COALESCE(SUM(
        oi.quantity * COALESCE(
          (SELECT AVG(pli.unit_cost) FROM inventory_po_line_items pli WHERE pli.sku_id = oi.sku_id AND pli.unit_cost > 0),
          0
        )
      ), 0) as cogs
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE o.placed_at >= ? AND o.placed_at <= ?
      AND o.status NOT IN ('cancelled', 'returned')
    GROUP BY o.channel
  `).all(startDate, endDate + "T23:59:59") as Array<{
    channel: string;
    order_count: number;
    revenue: number;
    cogs: number;
  }>;

  // Fees from settlements
  const feeData = sqlite.prepare(`
    SELECT channel, COALESCE(SUM(fees), 0) as total_fees
    FROM settlements
    WHERE period_start >= ? AND period_end <= ?
    GROUP BY channel
  `).all(startDate, endDate) as Array<{ channel: string; total_fees: number }>;

  const feesByChannel = new Map(feeData.map(f => [f.channel, f.total_fees]));

  // Build channel P&L
  const channels: ChannelPnl[] = channelData.map(c => {
    const fees = feesByChannel.get(c.channel) || 0;
    const grossMargin = c.revenue - c.cogs;
    return {
      channel: c.channel,
      channelLabel: CHANNEL_LABELS[c.channel] || c.channel,
      revenue: c.revenue,
      cogs: c.cogs,
      grossMargin,
      grossMarginPct: c.revenue > 0 ? (grossMargin / c.revenue) * 100 : 0,
      fees,
      orderCount: c.order_count,
    };
  });

  // Expenses by category
  const expenseData = sqlite.prepare(`
    SELECT 
      ec.name as category,
      COALESCE(SUM(e.amount), 0) as amount,
      ec.budget_monthly as budget
    FROM expenses e
    JOIN expense_categories ec ON e.category_id = ec.id
    WHERE e.date >= ? AND e.date <= ?
    GROUP BY ec.id, ec.name
    ORDER BY amount DESC
  `).all(startDate, endDate) as Array<{ category: string; amount: number; budget: number | null }>;

  // Totals
  const revenue = channels.reduce((s, c) => s + c.revenue, 0);
  const cogs = channels.reduce((s, c) => s + c.cogs, 0);
  const totalFees = channels.reduce((s, c) => s + c.fees, 0);
  const totalExpenses = expenseData.reduce((s, e) => s + e.amount, 0);
  const grossMargin = revenue - cogs;

  return {
    revenue,
    cogs,
    grossMargin,
    totalFees,
    totalExpenses,
    netIncome: grossMargin - totalFees - totalExpenses,
    channels,
    expensesByCategory: expenseData,
  };
}

export function calculatePnl(
  period: PnlPeriod = "mtd",
  customStart?: string,
  customEnd?: string
): PnlSummary {
  const dates = getPeriodDates(period, customStart, customEnd);
  const current = calculatePnlForRange(dates.start, dates.end);

  // Calculate comparison period
  const priorDates = getPriorPeriodDates(dates.start, dates.end);
  const prior = calculatePnlForRange(priorDates.start, priorDates.end);

  const comparison: PnlComparison = {
    priorPeriod: priorDates,
    revenue: prior.revenue,
    cogs: prior.cogs,
    grossMargin: prior.grossMargin,
    totalExpenses: prior.totalExpenses,
    netIncome: prior.netIncome,
    revenueChange: pctChange(current.revenue, prior.revenue),
    cogsChange: pctChange(current.cogs, prior.cogs),
    grossMarginChange: pctChange(current.grossMargin, prior.grossMargin),
    expensesChange: pctChange(current.totalExpenses, prior.totalExpenses),
    netIncomeChange: pctChange(current.netIncome, prior.netIncome),
  };

  return {
    period: dates,
    ...current,
    grossMarginPct: current.revenue > 0 ? (current.grossMargin / current.revenue) * 100 : 0,
    comparison,
  };
}

/** Generate CSV string of P&L data */
export function pnlToCsv(pnl: PnlSummary): string {
  const lines: string[] = [];
  lines.push(`P&L Report — ${pnl.period.label}`);
  lines.push(`Period: ${pnl.period.start} to ${pnl.period.end}`);
  lines.push("");
  
  // Summary
  lines.push("SUMMARY");
  lines.push(`Metric,Amount`);
  lines.push(`Revenue,"${pnl.revenue.toFixed(2)}"`);
  lines.push(`COGS,"${pnl.cogs.toFixed(2)}"`);
  lines.push(`Gross Margin,"${pnl.grossMargin.toFixed(2)}"`);
  lines.push(`Gross Margin %,"${pnl.grossMarginPct.toFixed(1)}%"`);
  lines.push(`Platform Fees,"${pnl.totalFees.toFixed(2)}"`);
  lines.push(`Operating Expenses,"${pnl.totalExpenses.toFixed(2)}"`);
  lines.push(`Net Income,"${pnl.netIncome.toFixed(2)}"`);
  lines.push("");
  
  // By Channel
  lines.push("REVENUE BY CHANNEL");
  lines.push("Channel,Orders,Revenue,COGS,Gross Margin,Margin %,Fees,Net");
  for (const ch of pnl.channels) {
    lines.push(`${ch.channelLabel},${ch.orderCount},"${ch.revenue.toFixed(2)}","${ch.cogs.toFixed(2)}","${ch.grossMargin.toFixed(2)}","${ch.grossMarginPct.toFixed(1)}%","${ch.fees.toFixed(2)}","${(ch.grossMargin - ch.fees).toFixed(2)}"`);
  }
  lines.push("");
  
  // Expenses by Category
  if (pnl.expensesByCategory.length > 0) {
    lines.push("EXPENSES BY CATEGORY");
    lines.push("Category,Amount,Budget");
    for (const ec of pnl.expensesByCategory) {
      lines.push(`${ec.category},"${ec.amount.toFixed(2)}","${ec.budget?.toFixed(2) || ""}"`);
    }
  }
  
  return lines.join("\n");
}
