/**
 * Business targets — the plan, and how actuals track against it.
 *
 * The frame was excellent at recording what happened and had nothing to say
 * about what was supposed to happen. This module supplies the missing half:
 * a target per (metric, scope, period), the matching actual computed from the
 * same tables the dashboard reads, and the pacing maths that turns the two
 * into a decision ("behind, projected to land 12% short").
 *
 * Adding a metric means adding one entry to METRICS — the API, the editor and
 * the dashboard all read from that registry.
 */

import { sqlite } from "@/lib/db";

export type PeriodType = "month" | "quarter" | "year";
export type ScopeType = "company" | "channel" | "rep";
export type MetricId =
  | "revenue" | "orders" | "units" | "aov" | "gross_margin_pct"
  | "new_accounts" | "dials" | "connect_rate" | "leads";

export interface Scope {
  type: ScopeType;
  /** null for company-wide; a channel key or user email/id otherwise. */
  id: string | null;
}

export interface MetricDef {
  id: MetricId;
  label: string;
  unit: "currency" | "count" | "percent";
  /** Scopes this metric can be targeted at. */
  scopes: ScopeType[];
  /** Short hint shown in the editor. */
  hint?: string;
  /** Rate metrics don't accumulate — pacing compares levels, not run-rates. */
  isRate?: boolean;
  actual: (start: string, end: string, scope: Scope) => number;
}

const NOT_CANCELLED = "o.status NOT IN ('cancelled','returned')";
const PLACED = "COALESCE(o.placed_at, o.created_at)";

function scalar(sql: string, ...args: unknown[]): number {
  try {
    const r = sqlite.prepare(sql).get(...args) as Record<string, unknown> | undefined;
    if (!r) return 0;
    const v = Object.values(r)[0];
    return typeof v === "number" && isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/** Channel filter fragment + args for order-based metrics. */
function channelFilter(scope: Scope): { sql: string; args: unknown[] } {
  if (scope.type === "channel" && scope.id) return { sql: "AND o.channel = ?", args: [scope.id] };
  return { sql: "", args: [] };
}

export const METRICS: Record<MetricId, MetricDef> = {
  revenue: {
    id: "revenue", label: "Revenue", unit: "currency", scopes: ["company", "channel"],
    hint: "Order value, excluding cancelled and returned",
    actual: (start, end, scope) => {
      const f = channelFilter(scope);
      return scalar(
        `SELECT COALESCE(SUM(o.total),0) v FROM orders o
          WHERE ${NOT_CANCELLED} AND ${PLACED} >= ? AND ${PLACED} < ? ${f.sql}`,
        start, end, ...f.args,
      );
    },
  },
  orders: {
    id: "orders", label: "Orders", unit: "count", scopes: ["company", "channel"],
    actual: (start, end, scope) => {
      const f = channelFilter(scope);
      return scalar(
        `SELECT COUNT(*) v FROM orders o
          WHERE ${NOT_CANCELLED} AND ${PLACED} >= ? AND ${PLACED} < ? ${f.sql}`,
        start, end, ...f.args,
      );
    },
  },
  units: {
    id: "units", label: "Units sold", unit: "count", scopes: ["company", "channel"],
    actual: (start, end, scope) => {
      const f = channelFilter(scope);
      return scalar(
        `SELECT COALESCE(SUM(oi.quantity),0) v FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE ${NOT_CANCELLED} AND ${PLACED} >= ? AND ${PLACED} < ? ${f.sql}`,
        start, end, ...f.args,
      );
    },
  },
  aov: {
    id: "aov", label: "Avg order value", unit: "currency", scopes: ["company", "channel"], isRate: true,
    actual: (start, end, scope) => {
      const rev = METRICS.revenue.actual(start, end, scope);
      const n = METRICS.orders.actual(start, end, scope);
      return n > 0 ? rev / n : 0;
    },
  },
  gross_margin_pct: {
    id: "gross_margin_pct", label: "Gross margin %", unit: "percent", scopes: ["company"], isRate: true,
    hint: "Revenue less FIFO COGS, as a percentage",
    actual: (start, end) => {
      const revenue = scalar(
        `SELECT COALESCE(SUM(o.total),0) v FROM orders o
          WHERE ${NOT_CANCELLED} AND ${PLACED} >= ? AND ${PLACED} < ?`, start, end);
      const cogs = scalar(
        `SELECT COALESCE(SUM(d.landed_cost_per_unit * d.quantity),0) v
           FROM inventory_cost_depletions d
          WHERE d.depleted_at >= ? AND d.depleted_at < ?`, start, end);
      return revenue > 0 ? ((revenue - cogs) / revenue) * 100 : 0;
    },
  },
  new_accounts: {
    id: "new_accounts", label: "New accounts", unit: "count", scopes: ["company"],
    hint: "Companies placing their first order in the period",
    actual: (start, end) =>
      scalar(
        `SELECT COUNT(*) v FROM (
           SELECT o.company_id, MIN(${PLACED}) first_at FROM orders o
            WHERE ${NOT_CANCELLED} AND o.company_id IS NOT NULL
            GROUP BY o.company_id
         ) WHERE first_at >= ? AND first_at < ?`, start, end),
  },
  dials: {
    id: "dials", label: "Calls dialled", unit: "count", scopes: ["company", "rep"],
    actual: (start, end, scope) => {
      const rep = scope.type === "rep" && scope.id ? "AND agent_email = ?" : "";
      const args = rep ? [scope.id] : [];
      return scalar(
        `SELECT COUNT(*) v FROM phoneburner_call_log WHERE called_at >= ? AND called_at < ? ${rep}`,
        start, end, ...args,
      );
    },
  },
  connect_rate: {
    id: "connect_rate", label: "Connect rate %", unit: "percent", scopes: ["company", "rep"], isRate: true,
    actual: (start, end, scope) => {
      const rep = scope.type === "rep" && scope.id ? "AND agent_email = ?" : "";
      const args = rep ? [scope.id] : [];
      const total = scalar(
        `SELECT COUNT(*) v FROM phoneburner_call_log WHERE called_at >= ? AND called_at < ? ${rep}`,
        start, end, ...args);
      const connected = scalar(
        `SELECT COUNT(*) v FROM phoneburner_call_log WHERE connected = 1 AND called_at >= ? AND called_at < ? ${rep}`,
        start, end, ...args);
      return total > 0 ? (connected / total) * 100 : 0;
    },
  },
  leads: {
    id: "leads", label: "New leads", unit: "count", scopes: ["company"],
    hint: "Facebook/Instagram lead-ad submissions",
    actual: (start, end) =>
      scalar(`SELECT COUNT(*) v FROM meta_leads WHERE created_at >= ? AND created_at < ?`, start, end),
  },
};

export const METRIC_IDS = Object.keys(METRICS) as MetricId[];

// ── periods ──

/** Canonical first day of the period containing `date`. */
export function periodStartFor(date: Date, type: PeriodType): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  if (type === "year") return `${y}-01-01`;
  if (type === "quarter") return `${y}-${String(Math.floor(m / 3) * 3 + 1).padStart(2, "0")}-01`;
  return `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

/** [start, end) ISO datetimes for a period. */
export function periodRange(periodStart: string, type: PeriodType): { start: string; end: string } {
  const [y, m] = periodStart.split("-").map(Number);
  const startDate = new Date(Date.UTC(y, (m || 1) - 1, 1));
  const endDate = new Date(startDate);
  if (type === "year") endDate.setUTCFullYear(endDate.getUTCFullYear() + 1);
  else if (type === "quarter") endDate.setUTCMonth(endDate.getUTCMonth() + 3);
  else endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  return { start: startDate.toISOString(), end: endDate.toISOString() };
}

export function periodLabel(periodStart: string, type: PeriodType): string {
  const [y, m] = periodStart.split("-").map(Number);
  if (type === "year") return String(y);
  if (type === "quarter") return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** Shift a period start by n periods. */
export function shiftPeriod(periodStart: string, type: PeriodType, n: number): string {
  const [y, m] = periodStart.split("-").map(Number);
  const d = new Date(Date.UTC(y, (m || 1) - 1, 1));
  if (type === "year") d.setUTCFullYear(d.getUTCFullYear() + n);
  else if (type === "quarter") d.setUTCMonth(d.getUTCMonth() + 3 * n);
  else d.setUTCMonth(d.getUTCMonth() + n);
  return periodStartFor(d, type);
}

// ── progress ──

export type ProgressStatus = "ahead" | "on_track" | "behind" | "at_risk" | "hit" | "missed" | "no_target";

export interface TargetRow {
  id: string;
  metric: MetricId;
  scope_type: ScopeType;
  scope_id: string | null;
  period_type: PeriodType;
  period_start: string;
  value: number;
  notes: string | null;
}

export interface Progress {
  metric: MetricId;
  label: string;
  unit: MetricDef["unit"];
  scopeType: ScopeType;
  scopeId: string | null;
  periodType: PeriodType;
  periodStart: string;
  periodLabel: string;
  target: number | null;
  actual: number;
  /** actual / target as a percentage (null without a target). */
  attainmentPct: number | null;
  /** How far through the period we are, 0–1. */
  elapsedPct: number;
  /** Where we should be by now to finish on target. */
  expectedToDate: number | null;
  /** End-of-period projection at the current run rate. */
  projected: number | null;
  /** Projected vs target, as a percentage difference. */
  projectedVsTargetPct: number | null;
  status: ProgressStatus;
  isComplete: boolean;
}

function statusFor(opts: {
  target: number | null; actual: number; expectedToDate: number | null; complete: boolean;
}): ProgressStatus {
  const { target, actual, expectedToDate, complete } = opts;
  if (target == null || target <= 0) return "no_target";
  if (complete) return actual >= target ? "hit" : "missed";
  if (expectedToDate == null || expectedToDate <= 0) return "on_track";
  const ratio = actual / expectedToDate;
  if (ratio >= 1.05) return "ahead";
  if (ratio >= 0.95) return "on_track";
  if (ratio >= 0.8) return "behind";
  return "at_risk";
}

/**
 * Compute progress for one target (or for a metric with no target set, so the
 * editor can still show the actual).
 */
export function computeProgress(opts: {
  metric: MetricId;
  scope: Scope;
  periodType: PeriodType;
  periodStart: string;
  target: number | null;
  now?: Date;
}): Progress {
  const def = METRICS[opts.metric];
  const { start, end } = periodRange(opts.periodStart, opts.periodType);
  const now = opts.now ?? new Date();
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const elapsedPct = Math.max(0, Math.min(1, (now.getTime() - startMs) / (endMs - startMs)));
  const isComplete = now.getTime() >= endMs;

  // Only measure up to now — counting a full future month as "elapsed" would
  // make every in-flight period look catastrophically behind.
  const measureEnd = isComplete ? end : new Date(Math.min(now.getTime(), endMs)).toISOString();
  const actual = def.actual(start, measureEnd, opts.scope);

  const target = opts.target;
  // Rate metrics (AOV, margin %, connect rate) are levels, not accumulations:
  // the expected value at any point in the period is simply the target.
  const expectedToDate = target == null ? null : def.isRate ? target : target * elapsedPct;
  const projected =
    target == null ? null : def.isRate ? actual : elapsedPct > 0.02 ? actual / elapsedPct : null;

  return {
    metric: def.id,
    label: def.label,
    unit: def.unit,
    scopeType: opts.scope.type,
    scopeId: opts.scope.id,
    periodType: opts.periodType,
    periodStart: opts.periodStart,
    periodLabel: periodLabel(opts.periodStart, opts.periodType),
    target,
    actual,
    attainmentPct: target && target > 0 ? (actual / target) * 100 : null,
    elapsedPct,
    expectedToDate,
    projected,
    projectedVsTargetPct:
      target && target > 0 && projected != null ? ((projected - target) / target) * 100 : null,
    status: statusFor({ target, actual, expectedToDate, complete: isComplete }),
    isComplete,
  };
}

// ── storage ──

export function listTargets(filter: { periodType?: PeriodType; periodStart?: string } = {}): TargetRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.periodType) { where.push("period_type = ?"); args.push(filter.periodType); }
  if (filter.periodStart) { where.push("period_start = ?"); args.push(filter.periodStart); }
  try {
    return sqlite
      .prepare(`SELECT * FROM targets ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY period_start DESC, metric`)
      .all(...args) as TargetRow[];
  } catch {
    return [];
  }
}

export function upsertTarget(input: {
  metric: MetricId; scopeType: ScopeType; scopeId: string | null;
  periodType: PeriodType; periodStart: string; value: number; notes?: string | null; userId?: string | null;
}): void {
  sqlite
    .prepare(
      `INSERT INTO targets (id, metric, scope_type, scope_id, period_type, period_start, value, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (metric, scope_type, scope_id, period_type, period_start)
       DO UPDATE SET value = excluded.value, notes = excluded.notes, updated_at = datetime('now')`,
    )
    .run(
      crypto.randomUUID(), input.metric, input.scopeType, input.scopeId,
      input.periodType, input.periodStart, input.value, input.notes ?? null, input.userId ?? null,
    );
}

export function deleteTarget(id: string): void {
  sqlite.prepare("DELETE FROM targets WHERE id = ?").run(id);
}

/**
 * Progress for every metric in a period — targets where set, actuals always,
 * so the page doubles as "how are we doing" and "what still needs a number."
 */
export function progressForPeriod(periodType: PeriodType, periodStart: string): Progress[] {
  const rows = listTargets({ periodType, periodStart });
  const byKey = new Map(rows.map((r) => [`${r.metric}|${r.scope_type}|${r.scope_id ?? ""}`, r]));

  const out: Progress[] = [];
  // Company-wide line for every metric.
  for (const metric of METRIC_IDS) {
    const row = byKey.get(`${metric}|company|`);
    out.push(computeProgress({
      metric, scope: { type: "company", id: null }, periodType, periodStart,
      target: row?.value ?? null,
    }));
  }
  // Any scoped targets that exist (channel/rep) come after.
  for (const r of rows) {
    if (r.scope_type === "company") continue;
    out.push(computeProgress({
      metric: r.metric, scope: { type: r.scope_type, id: r.scope_id },
      periodType, periodStart, target: r.value,
    }));
  }
  return out;
}
