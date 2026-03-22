/**
 * AI Cash Flow Predictor (Phase 7 — rule-based)
 * 
 * Projects cash position based on historical settlement patterns.
 * Identifies potential cash crunches and suggests actions.
 */

import { sqlite } from "@/lib/db";

export interface CashFlowPrediction {
  currentBalance: number;
  projections: Array<{
    weekOffset: number;
    weekLabel: string;
    expectedInflows: number;
    expectedOutflows: number;
    projectedBalance: number;
    risk: "safe" | "tight" | "danger";
  }>;
  alerts: string[];
  insights: string[];
}

export function predictCashFlow(weeksAhead: number = 12): CashFlowPrediction {
  const now = new Date();

  // Current balance: received settlements - expenses - PO costs
  const received = (sqlite.prepare(`
    SELECT COALESCE(SUM(net_amount), 0) as total FROM settlements WHERE status IN ('received', 'reconciled', 'synced_to_xero')
  `).get() as { total: number }).total;

  const expensesTotal = (sqlite.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM expenses
  `).get() as { total: number }).total;

  const poCosts = (sqlite.prepare(`
    SELECT COALESCE(SUM(total_cost), 0) as total FROM inventory_purchase_orders WHERE status NOT IN ('draft', 'cancelled')
  `).get() as { total: number } | undefined)?.total || 0;

  const currentBalance = received - expensesTotal - poCosts;

  // Historical weekly settlement averages by channel
  const channelAvgs = sqlite.prepare(`
    SELECT channel, AVG(net_amount) as avg_net, COUNT(*) as settlement_count
    FROM settlements
    WHERE status IN ('received', 'reconciled', 'synced_to_xero')
    GROUP BY channel
  `).all() as Array<{ channel: string; avg_net: number; settlement_count: number }>;

  // Weekly inflow estimate
  // Shopify: weekly, Faire: monthly (~4 weeks), Amazon: bi-weekly (~2 weeks)
  let weeklyInflow = 0;
  for (const ch of channelAvgs) {
    switch (ch.channel) {
      case "shopify_dtc":
      case "shopify_wholesale":
        weeklyInflow += ch.avg_net; // already weekly
        break;
      case "faire":
        weeklyInflow += ch.avg_net / 4; // monthly → weekly
        break;
      case "amazon":
        weeklyInflow += ch.avg_net / 2; // bi-weekly → weekly
        break;
    }
  }

  // Monthly recurring expenses
  const monthlyExpenses = (sqlite.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE recurring = 1 AND frequency = 'monthly'
  `).get() as { total: number }).total;

  const weeklyOutflow = monthlyExpenses / 4.33;

  // Pending POs (future outflows)
  const pendingPOs = sqlite.prepare(`
    SELECT total_cost, expected_arrival_date FROM inventory_purchase_orders WHERE status IN ('draft', 'pending', 'confirmed', 'in_production')
  `).all() as Array<{ total_cost: number; expected_arrival_date: string | null }>;

  // Project week by week
  let balance = currentBalance;
  const projections: CashFlowPrediction["projections"] = [];
  const alerts: string[] = [];

  for (let w = 1; w <= weeksAhead; w++) {
    const weekDate = new Date(now);
    weekDate.setDate(weekDate.getDate() + w * 7);
    const weekLabel = `Week ${w} (${weekDate.toISOString().split("T")[0]})`;

    let inflows = weeklyInflow;
    let outflows = weeklyOutflow;

    // Check if any POs are expected this week
    for (const po of pendingPOs) {
      if (po.expected_arrival_date) {
        const poDate = new Date(po.expected_arrival_date);
        const diffDays = (poDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
        if (diffDays >= (w - 1) * 7 && diffDays < w * 7) {
          outflows += po.total_cost;
        }
      }
    }

    balance += inflows - outflows;

    let risk: "safe" | "tight" | "danger";
    if (balance < 0) {
      risk = "danger";
      if (!alerts.some((a) => a.includes("negative"))) {
        alerts.push(`⚠️ Projected to go negative in ${weekLabel}. Review expenses or accelerate collections.`);
      }
    } else if (balance < monthlyExpenses) {
      risk = "tight";
      if (!alerts.some((a) => a.includes("tight"))) {
        alerts.push(`⚡ Cash gets tight in ${weekLabel} — below one month of expenses.`);
      }
    } else {
      risk = "safe";
    }

    projections.push({
      weekOffset: w,
      weekLabel,
      expectedInflows: Math.round(inflows * 100) / 100,
      expectedOutflows: Math.round(outflows * 100) / 100,
      projectedBalance: Math.round(balance * 100) / 100,
      risk,
    });
  }

  // Generate insights
  const insights: string[] = [];
  if (weeklyInflow > 0) {
    insights.push(`Average weekly inflow: $${weeklyInflow.toFixed(0)} across ${channelAvgs.length} channels.`);
  }
  if (weeklyOutflow > 0) {
    insights.push(`Average weekly burn: $${weeklyOutflow.toFixed(0)} from recurring expenses.`);
  }
  const runway = weeklyOutflow > 0 ? Math.floor(currentBalance / weeklyOutflow) : Infinity;
  if (runway < Infinity) {
    insights.push(`Current runway: ~${runway} weeks at current burn rate (excluding new revenue).`);
  }
  if (pendingPOs.length > 0) {
    const totalPOCost = pendingPOs.reduce((s, p) => s + p.total_cost, 0);
    insights.push(`${pendingPOs.length} pending POs totaling $${totalPOCost.toFixed(0)} will impact cash flow.`);
  }

  return { currentBalance: Math.round(currentBalance * 100) / 100, projections, alerts, insights };
}
