/**
 * Dashboard metrics assembler.
 *
 * buildDashboard(role, range) computes each widget's dataset ONLY if the role
 * may see that widget, reusing existing engines where they're cheap and
 * side-effect-free (calculatePnl, getHealthSummary, calculateBusinessHealth,
 * loadPhoneBurnerMetrics) and lightweight SQL otherwise. It deliberately
 * avoids the heavy/side-effecting inventory passes (runDemandForecast,
 * calculateSellThrough writes back to the inventory table) — the dashboard
 * reads the persisted inventory flags instead and links out to the full
 * forecast for detail.
 */

import { sqlite } from "@/lib/db";
import { canSeeWidget, HEAVY_WIDGETS, type WidgetId } from "../widgets";
import { calculatePnl } from "@/modules/finance/lib/pnl";
import { getHealthSummary } from "@/modules/customers/lib/health-scoring";
import { calculateBusinessHealth } from "@/modules/intelligence/lib/business-health";
import { loadPhoneBurnerMetrics } from "@/modules/integrations/lib/slack/digests";
import { getProductPerformance, getColorPerformance } from "@/modules/inventory/lib/product-performance";
import { progressForPeriod, periodStartFor } from "@/modules/planning/lib/targets";

export type Range = "7d" | "30d" | "90d" | "ytd";

function rangeStart(range: Range): { start: string; priorStart: string; priorEnd: string; days: number } {
  const now = Date.now();
  const day = 86400000;
  let days = 30;
  if (range === "7d") days = 7;
  else if (range === "90d") days = 90;
  else if (range === "ytd") days = Math.max(1, Math.ceil((now - new Date(new Date().getFullYear(), 0, 1).getTime()) / day));
  const start = new Date(now - days * day).toISOString();
  const priorEnd = start;
  const priorStart = new Date(now - 2 * days * day).toISOString();
  return { start, priorStart, priorEnd, days };
}

const NOT_CANCELLED = "status NOT IN ('cancelled','returned')";

function scalar(sql: string, ...args: unknown[]): number {
  const r = sqlite.prepare(sql).get(...args) as Record<string, number> | undefined;
  if (!r) return 0;
  const v = Object.values(r)[0];
  return typeof v === "number" ? v : 0;
}

// ── individual builders ──

function buildKpis(start: string, priorStart: string, priorEnd: string) {
  const revenue = scalar(`SELECT COALESCE(SUM(total),0) v FROM orders WHERE ${NOT_CANCELLED} AND COALESCE(placed_at,created_at) >= ?`, start);
  const priorRevenue = scalar(`SELECT COALESCE(SUM(total),0) v FROM orders WHERE ${NOT_CANCELLED} AND COALESCE(placed_at,created_at) >= ? AND COALESCE(placed_at,created_at) < ?`, priorStart, priorEnd);
  const orders = scalar(`SELECT COUNT(*) v FROM orders WHERE ${NOT_CANCELLED} AND COALESCE(placed_at,created_at) >= ?`, start);
  const priorOrders = scalar(`SELECT COUNT(*) v FROM orders WHERE ${NOT_CANCELLED} AND COALESCE(placed_at,created_at) >= ? AND COALESCE(placed_at,created_at) < ?`, priorStart, priorEnd);
  const aov = orders ? revenue / orders : 0;
  const priorAov = priorOrders ? priorRevenue / priorOrders : 0;
  const pipelineValue = scalar(`SELECT COALESCE(SUM(value),0) v FROM pipedrive_deals WHERE is_open = 1`);
  const openDeals = scalar(`SELECT COUNT(*) v FROM pipedrive_deals WHERE is_open = 1`);
  const lowStock = scalar(`SELECT COUNT(*) v FROM inventory WHERE location='warehouse' AND quantity <= reorder_point`);
  const inventoryUnits = scalar(`SELECT COALESCE(SUM(quantity),0) v FROM inventory WHERE location='warehouse'`);
  const newLeads = scalar(`SELECT COUNT(*) v FROM meta_leads WHERE created_at >= ?`, start);
  return { revenue, priorRevenue, orders, priorOrders, aov, priorAov, pipelineValue, openDeals, lowStock, inventoryUnits, newLeads };
}

function buildRevenueTrend(start: string, days: number) {
  const bucket = days > 45 ? "week" : "day";
  const rows = sqlite
    .prepare(
      `SELECT substr(COALESCE(placed_at,created_at),1,10) d, SUM(total) v
         FROM orders WHERE ${NOT_CANCELLED} AND COALESCE(placed_at,created_at) >= ?
        GROUP BY d ORDER BY d ASC`,
    )
    .all(start) as Array<{ d: string; v: number }>;
  // Fill gaps for daily view so the line is continuous.
  if (bucket === "day") {
    const map = new Map(rows.map((r) => [r.d, r.v]));
    const out: Array<{ label: string; value: number }> = [];
    const startMs = new Date(start).getTime();
    for (let i = 0; i <= days; i++) {
      const d = new Date(startMs + i * 86400000).toISOString().slice(0, 10);
      out.push({ label: d, value: map.get(d) ?? 0 });
    }
    return out;
  }
  return rows.map((r) => ({ label: r.d, value: r.v }));
}

function buildChannelMix(start: string) {
  return sqlite
    .prepare(
      `SELECT channel, SUM(total) revenue, COUNT(*) orders
         FROM orders WHERE ${NOT_CANCELLED} AND COALESCE(placed_at,created_at) >= ?
        GROUP BY channel ORDER BY revenue DESC`,
    )
    .all(start) as Array<{ channel: string; revenue: number; orders: number }>;
}

/**
 * Color demand for the dashboard.
 *
 * Runs on a 365-day window regardless of the dashboard's date filter: color
 * seasonality is the whole point, and a 30-day view would report "black is
 * 40%" every month without ever showing that brights spike in spring. The
 * window is stated in the widget so the number isn't mistaken for the period.
 */
function buildColorInsight() {
  const res = getColorPerformance({ windowDays: 365 });
  const top = res.rows.filter((r) => r.units > 0).slice(0, 6);
  return {
    windowDays: res.windowDays,
    months: res.months,
    totalUnits: res.totals.units,
    rows: top.map((r) => ({
      color: r.color,
      units: r.units,
      unitSharePct: r.unitSharePct,
      trendPct: r.trendPct,
      trend: r.trend,
      onHand: r.onHand,
      onOrder: r.onOrder,
      peakMonth: r.peakMonth,
      seasonalityIndex: r.seasonalityIndex,
      byMonth: r.byMonth.map((m) => m.units),
    })),
    /**
     * Colors holding stock that didn't sell at all in a year — the clearest
     * over-buy signal there is, and invisible in any product-level view.
     */
    stale: res.rows
      .filter((r) => r.units === 0 && r.onHand + r.onOrder > 0)
      .sort((a, b) => b.onHand + b.onOrder - (a.onHand + a.onOrder))
      .slice(0, 3)
      .map((r) => ({ color: r.color, onHand: r.onHand, onOrder: r.onOrder })),
  };
}

/**
 * Top sellers + movers share one pass of the product-performance engine (it
 * resolves every order line through the pack/alias-aware root resolver, so it's
 * the expensive part — computing it twice would double the work).
 */
function buildProductInsight(days: number) {
  const perf = getProductPerformance({ windowDays: days });
  const rows = perf.rows;
  const scored = rows.filter((r) => r.trendPct != null && r.units >= 8);
  return {
    topSellers: rows.slice(0, 8).map((r) => ({
      sku: r.rootSku,
      name: r.productName,
      color: r.colorName,
      units: r.units,
      revenue: r.revenue,
      unitsWholesale: r.unitsWholesale,
      unitsRetail: r.unitsRetail,
      wholesaleSharePct: r.wholesaleSharePct,
      avgOrderQty: r.avgOrderQty,
      accounts: r.accounts,
      // Stock position alongside the sales figure — a top seller with nothing
      // on hand and nothing inbound is the most urgent row on the dashboard,
      // and without these two numbers it looks identical to a healthy one.
      onHand: r.onHand,
      onOrder: r.onOrder,
      daysCover: r.daysCover,
      daysCoverWithIncoming: r.daysCoverWithIncoming,
    })),
    movers: {
      rising: [...scored].sort((a, b) => (b.trendPct ?? 0) - (a.trendPct ?? 0)).slice(0, 4)
        .map((r) => ({ sku: r.rootSku, name: r.productName, color: r.colorName, trendPct: r.trendPct, units: r.units, daysCover: r.daysCover })),
      falling: [...scored].filter((r) => (r.trendPct ?? 0) < 0).sort((a, b) => (a.trendPct ?? 0) - (b.trendPct ?? 0)).slice(0, 4)
        .map((r) => ({ sku: r.rootSku, name: r.productName, color: r.colorName, trendPct: r.trendPct, units: r.units, daysCover: r.daysCover })),
      breakout: rows.filter((r) => r.trend === "new" && r.units >= 8).sort((a, b) => b.units - a.units).slice(0, 3)
        .map((r) => ({ sku: r.rootSku, name: r.productName, color: r.colorName, units: r.units })),
    },
    wholesaleSharePct: perf.totals.wholesaleSharePct,
  };
}

function buildInventoryHealth() {
  const velocity = sqlite
    .prepare(
      `SELECT
         SUM(CASE WHEN sell_through_weekly >= 10 THEN 1 ELSE 0 END) fast,
         SUM(CASE WHEN sell_through_weekly >= 3 AND sell_through_weekly < 10 THEN 1 ELSE 0 END) normal,
         SUM(CASE WHEN sell_through_weekly >= 0.5 AND sell_through_weekly < 3 THEN 1 ELSE 0 END) slow,
         SUM(CASE WHEN sell_through_weekly < 0.5 THEN 1 ELSE 0 END) dead
       FROM inventory WHERE location='warehouse'`,
    )
    .get() as { fast: number; normal: number; slow: number; dead: number };
  const outOfStock = scalar(`SELECT COUNT(*) v FROM inventory WHERE location='warehouse' AND quantity <= 0`);
  const needsReorder = scalar(`SELECT COUNT(*) v FROM inventory WHERE location='warehouse' AND (needs_reorder = 1 OR quantity <= reorder_point)`);
  const units = scalar(`SELECT COALESCE(SUM(quantity),0) v FROM inventory WHERE location='warehouse'`);
  const value = scalar(`SELECT COALESCE(SUM(i.quantity * COALESCE(s.cost_price,0)),0) v FROM inventory i JOIN catalog_skus s ON s.id = i.sku_id WHERE i.location='warehouse'`);
  return { velocity, outOfStock, needsReorder, units, value };
}

function buildReorderAlerts() {
  const rows = sqlite
    .prepare(
      `SELECT s.sku, p.name, s.color_name color, i.quantity, i.reserved_quantity reserved,
              i.reorder_point, i.days_of_stock, i.sell_through_weekly velocity
         FROM inventory i JOIN catalog_skus s ON s.id = i.sku_id JOIN catalog_products p ON p.id = s.product_id
        WHERE i.location='warehouse' AND (i.needs_reorder = 1 OR i.quantity <= i.reorder_point)
        ORDER BY (i.quantity <= 0) DESC, i.days_of_stock ASC LIMIT 8`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows;
}

function buildOutreach(start: string, end: string, priorStart: string, priorEnd: string) {
  const calls = loadPhoneBurnerMetrics(start, end);
  const priorCalls = loadPhoneBurnerMetrics(priorStart, priorEnd);
  const emailRow = sqlite
    .prepare(
      `SELECT
         SUM(CASE WHEN event_type='email_sent' THEN 1 ELSE 0 END) sent,
         SUM(CASE WHEN event_type IN ('reply_received','auto_reply_received') THEN 1 ELSE 0 END) replies,
         SUM(CASE WHEN event_type='lead_interested' THEN 1 ELSE 0 END) interested
       FROM instantly_webhook_events WHERE received_at >= ?`,
    )
    .get(start) as { sent: number | null; replies: number | null; interested: number | null } | undefined;
  return {
    calls: { total: calls.total, connected: calls.connected, interested: calls.interested, priorConnected: priorCalls.connected, priorTotal: priorCalls.total },
    email: { sent: emailRow?.sent ?? 0, replies: emailRow?.replies ?? 0, interested: emailRow?.interested ?? 0 },
  };
}

function buildMetaLeads(start: string) {
  const total = scalar(`SELECT COUNT(*) v FROM meta_leads WHERE created_at >= ?`, start);
  const processed = scalar(`SELECT COUNT(*) v FROM meta_leads WHERE status='processed' AND created_at >= ?`, start);
  const byCampaign = sqlite
    .prepare(
      `SELECT COALESCE(campaign_name,'(unattributed)') campaign, COUNT(*) n
         FROM meta_leads WHERE created_at >= ? GROUP BY campaign ORDER BY n DESC LIMIT 5`,
    )
    .all(start) as Array<{ campaign: string; n: number }>;
  const converted = scalar(
    `SELECT COUNT(DISTINCT ml.id) v FROM meta_leads ml
       JOIN orders o ON o.company_id = ml.company_id AND o.${NOT_CANCELLED}
      WHERE ml.created_at >= ?`,
    start,
  );
  return { total, processed, converted, byCampaign };
}

function buildPipeline() {
  const byStage = sqlite
    .prepare(
      `SELECT pipeline, stage, COUNT(*) deals, COALESCE(SUM(value),0) value
         FROM pipedrive_deals WHERE is_open = 1 GROUP BY pipeline, stage ORDER BY value DESC`,
    )
    .all() as Array<{ pipeline: string; stage: string; deals: number; value: number }>;
  const totals = sqlite
    .prepare(
      `SELECT
         SUM(CASE WHEN is_open=1 THEN 1 ELSE 0 END) open,
         SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) won,
         SUM(CASE WHEN status='lost' THEN 1 ELSE 0 END) lost,
         COALESCE(SUM(CASE WHEN is_open=1 THEN value ELSE 0 END),0) openValue
       FROM pipedrive_deals`,
    )
    .get() as { open: number; won: number; lost: number; openValue: number };
  return { byStage, totals };
}

function buildActivity() {
  return sqlite
    .prepare(`SELECT event_type, module, entity_type, entity_id, data, created_at FROM activity_feed ORDER BY created_at DESC LIMIT 12`)
    .all() as Array<Record<string, unknown>>;
}

// ── orchestrator ──

/**
 * Widgets split by cost. "core" widgets are simple indexed aggregates and
 * return in milliseconds; "heavy" ones scan whole tables (product performance
 * resolves every order line; FIFO P&L and business health run many queries).
 * The client requests them separately so the page paints immediately and the
 * expensive cards fill in behind their own skeletons.
 */
export type Part = "core" | "heavy" | "all";

/** Widget ids served by the heavy part. */
export function buildDashboard(role: string, range: Range, part: Part = "all") {
  const { start, priorStart, priorEnd, days } = rangeStart(range);
  const now = new Date().toISOString();
  const wantCore = part === "core" || part === "all";
  const wantHeavy = part === "heavy" || part === "all";
  const has = (id: WidgetId) =>
    canSeeWidget(role, id) && (HEAVY_WIDGETS.includes(id) ? wantHeavy : wantCore);

  const widgets: Record<string, unknown> = {};
  // Each builder is isolated: a missing table or query error blanks that one
  // widget (fallback value), never the whole dashboard.
  const safe = <T,>(key: string, fn: () => T, fallback: unknown) => {
    try { widgets[key] = fn(); } catch (e) {
      console.warn(`[dashboard] widget "${key}" failed:`, e instanceof Error ? e.message : e);
      widgets[key] = fallback;
    }
  };

  // KPIs are always computed (the strip adapts to role client-side).
  if (wantCore) safe("kpis", () => buildKpis(start, priorStart, priorEnd), null);

  if (has("revenue-trend")) safe("revenueTrend", () => buildRevenueTrend(start, days), []);
  if (has("channel-mix")) safe("channelMix", () => buildChannelMix(start), []);
  if (has("top-sellers") || has("movers")) {
    safe("productInsight", () => buildProductInsight(days), null);
  }
  if (has("top-colors")) safe("colorInsight", () => buildColorInsight(), null);
  if (has("inventory-health")) safe("inventoryHealth", () => buildInventoryHealth(), null);
  if (has("reorder-alerts")) safe("reorderAlerts", () => buildReorderAlerts(), []);
  if (has("outreach")) safe("outreach", () => buildOutreach(start, now, priorStart, priorEnd), null);
  if (has("meta-leads")) safe("metaLeads", () => buildMetaLeads(start), null);
  if (has("pipeline")) safe("pipeline", () => buildPipeline(), null);
  if (has("customers")) safe("customers", () => getHealthSummary(), { byStatus: [], byTier: [] });
  if (has("finance")) safe("finance", () => calculatePnl("mtd"), { error: "unavailable" });
  if (has("business-health")) safe("businessHealth", () => calculateBusinessHealth(), { error: "unavailable" });
  if (has("targets")) {
    safe("targets", () => {
      const periodStart = periodStartFor(new Date(), "month");
      return progressForPeriod("month", periodStart)
        .filter((p) => p.scopeType === "company" && p.target != null)
        .map((p) => ({
          metric: p.metric, label: p.label, unit: p.unit,
          target: p.target, actual: p.actual, attainmentPct: p.attainmentPct,
          elapsedPct: p.elapsedPct, projectedVsTargetPct: p.projectedVsTargetPct,
          status: p.status, periodLabel: p.periodLabel,
        }));
    }, []);
  }
  if (has("activity")) safe("activity", () => buildActivity(), []);

  return { role, range, part, generatedAt: now, widgets };
}
