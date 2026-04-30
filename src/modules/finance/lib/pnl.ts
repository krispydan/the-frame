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
  /** Units we have a cost on file for. */
  cogsCoveredUnits: number;
  /** Total units sold across the channel for the period. */
  totalUnits: number;
  /** True only when every unit had a cost on file. False = COGS is partial. */
  hasFullCostData: boolean;
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
  // ── Revenue per channel ──
  // No join. Joining order_items multiplies SUM(o.total) by the number of
  // line items per order (Cartesian product) — an order with 45 items had
  // its total counted 45 times, inflating revenue ~18x in production.
  // One row per order, then sum.
  const revenueData = sqlite.prepare(`
    SELECT
      o.channel,
      COUNT(*) as order_count,
      COALESCE(SUM(o.total), 0) as revenue
    FROM orders o
    WHERE o.placed_at >= ? AND o.placed_at <= ?
      AND o.status NOT IN ('cancelled', 'returned')
    GROUP BY o.channel
  `).all(startDate, endDate + "T23:59:59") as Array<{
    channel: string;
    order_count: number;
    revenue: number;
  }>;

  // ── COGS per channel ──
  // Separate query that joins order_items. COGS lookup order per item:
  //   1. catalog_skus.cost_price           (manually entered, matches order detail)
  //   2. AVG(inventory_po_line_items.unit_cost) for the SKU
  //   3. NULL — line is excluded from the COGS sum so margin doesn't lie.
  //
  // Returns coverage stats so the UI can flag partial COGS data.
  const cogsData = sqlite.prepare(`
    SELECT
      o.channel,
      COALESCE(SUM(
        oi.quantity * COALESCE(
          cs.cost_price,
          (SELECT AVG(pli.unit_cost) FROM inventory_po_line_items pli WHERE pli.sku_id = oi.sku_id AND pli.unit_cost > 0)
        )
      ), 0) as cogs,
      COALESCE(SUM(
        CASE
          WHEN cs.cost_price IS NOT NULL THEN oi.quantity
          WHEN (SELECT AVG(pli.unit_cost) FROM inventory_po_line_items pli WHERE pli.sku_id = oi.sku_id AND pli.unit_cost > 0) IS NOT NULL THEN oi.quantity
          ELSE 0
        END
      ), 0) as cogs_covered_units,
      COALESCE(SUM(oi.quantity), 0) as total_units
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN catalog_skus cs ON cs.id = oi.sku_id
    WHERE o.placed_at >= ? AND o.placed_at <= ?
      AND o.status NOT IN ('cancelled', 'returned')
    GROUP BY o.channel
  `).all(startDate, endDate + "T23:59:59") as Array<{
    channel: string;
    cogs: number;
    cogs_covered_units: number;
    total_units: number;
  }>;

  // Merge revenue + cogs per channel
  const cogsByChannel = new Map(cogsData.map((r) => [r.channel, r]));
  const channelData = revenueData.map((r) => {
    const c = cogsByChannel.get(r.channel);
    return {
      channel: r.channel,
      order_count: r.order_count,
      revenue: r.revenue,
      cogs: c?.cogs ?? 0,
      cogs_covered_units: c?.cogs_covered_units ?? 0,
      total_units: c?.total_units ?? 0,
    };
  });

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
      cogsCoveredUnits: c.cogs_covered_units,
      totalUnits: c.total_units,
      hasFullCostData: c.total_units > 0 && c.cogs_covered_units >= c.total_units,
    };
  });

  // Expenses are managed in Xero (per Daniel — Apr 2026). Locally tracked
  // expenses are no longer factored into P&L. The expensesByCategory field is
  // kept on the response shape (empty array) so existing UI components don't
  // break, but we don't read from the local expenses table anymore.
  // TODO: once Xero payout sync is wired up (Phase 2+), pull operating
  // expenses from the Xero GL via the API and surface them here.
  const expenseData: Array<{ category: string; amount: number; budget: number | null }> = [];

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
