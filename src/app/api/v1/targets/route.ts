export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/get-session";
import {
  listTargets, upsertTarget, deleteTarget, progressForPeriod,
  periodStartFor, shiftPeriod, METRICS, METRIC_IDS,
  type MetricId, type PeriodType, type ScopeType,
} from "@/modules/planning/lib/targets";

/**
 * Business targets.
 *
 * GET    ?periodType=month&periodStart=2026-08-01
 *          → progress for every metric in that period (targets + actuals),
 *            plus the metric registry for the editor.
 * PUT    { targets: [{ metric, scopeType, scopeId, periodType, periodStart, value }] }
 *          → upsert one or many (the grid saves a whole column at a time).
 * DELETE ?id=…  → clear a target.
 *
 * Setting targets is an owner/finance decision, so writes are gated to those
 * roles; everyone authenticated can read the plan they're being measured on.
 */

const WRITE_ROLES = ["owner", "finance"];

function normPeriod(t: string | null): PeriodType {
  return (["month", "quarter", "year"] as string[]).includes(t || "") ? (t as PeriodType) : "month";
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const params = req.nextUrl.searchParams;
  const periodType = normPeriod(params.get("periodType"));
  const periodStart = params.get("periodStart") || periodStartFor(new Date(), periodType);

  const progress = progressForPeriod(periodType, periodStart);
  return NextResponse.json({
    ok: true,
    periodType,
    periodStart,
    prevPeriod: shiftPeriod(periodStart, periodType, -1),
    nextPeriod: shiftPeriod(periodStart, periodType, 1),
    canEdit: WRITE_ROLES.includes(user.role),
    metrics: METRIC_IDS.map((id) => ({
      id,
      label: METRICS[id].label,
      unit: METRICS[id].unit,
      scopes: METRICS[id].scopes,
      hint: METRICS[id].hint ?? null,
      isRate: Boolean(METRICS[id].isRate),
    })),
    progress,
    raw: listTargets({ periodType, periodStart }),
  });
}

export async function PUT(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!WRITE_ROLES.includes(user.role)) {
    return NextResponse.json({ error: "only owner or finance can set targets" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const input = Array.isArray(body.targets) ? body.targets : [body];
  let saved = 0;
  const errors: string[] = [];

  for (const t of input) {
    const metric = String(t.metric || "") as MetricId;
    if (!METRIC_IDS.includes(metric)) { errors.push(`unknown metric "${t.metric}"`); continue; }
    const scopeType = (["company", "channel", "rep"].includes(t.scopeType) ? t.scopeType : "company") as ScopeType;
    if (!METRICS[metric].scopes.includes(scopeType)) {
      errors.push(`${metric} can't be scoped to ${scopeType}`);
      continue;
    }
    const periodType = normPeriod(t.periodType ?? "month");
    const periodStart = String(t.periodStart || periodStartFor(new Date(), periodType));
    const value = Number(t.value);
    if (!isFinite(value) || value < 0) { errors.push(`invalid value for ${metric}`); continue; }

    upsertTarget({
      metric, scopeType, scopeId: t.scopeId ?? null, periodType, periodStart,
      value, notes: t.notes ?? null, userId: user.id,
    });
    saved++;
  }

  return NextResponse.json({ ok: errors.length === 0, saved, errors });
}

/**
 * POST { action: "copy-previous", periodType, periodStart, growthPct? }
 *
 * Fills a period's targets from the PREVIOUS period's actuals, optionally
 * grown by a percentage — the realistic way most plans get written, and far
 * faster than typing nine numbers. Never overwrites a target already set.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!WRITE_ROLES.includes(user.role)) {
    return NextResponse.json({ error: "only owner or finance can set targets" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  if (body.action !== "copy-previous") {
    return NextResponse.json({ error: `unknown action "${body.action}"` }, { status: 400 });
  }

  const periodType = normPeriod(body.periodType);
  const periodStart = String(body.periodStart || periodStartFor(new Date(), periodType));
  const growth = Number(body.growthPct ?? 0);
  const prevStart = shiftPeriod(periodStart, periodType, -1);

  const existing = new Set(
    listTargets({ periodType, periodStart })
      .filter((t) => t.scope_type === "company")
      .map((t) => t.metric),
  );
  const prior = progressForPeriod(periodType, prevStart).filter((p) => p.scopeType === "company");

  const filled: Array<{ metric: string; value: number }> = [];
  for (const p of prior) {
    if (existing.has(p.metric) || p.actual <= 0) continue;
    // Rates shouldn't be inflated by a growth factor the way volumes are.
    const raw = METRICS[p.metric].isRate ? p.actual : p.actual * (1 + growth / 100);
    const value = METRICS[p.metric].unit === "percent" ? Math.round(raw * 10) / 10 : Math.round(raw);
    upsertTarget({
      metric: p.metric, scopeType: "company", scopeId: null, periodType, periodStart,
      value, notes: `From ${p.periodLabel} actuals${growth ? ` +${growth}%` : ""}`, userId: user.id,
    });
    filled.push({ metric: p.metric, value });
  }

  return NextResponse.json({ ok: true, filled, from: prevStart, skipped: [...existing] });
}

export async function DELETE(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!WRITE_ROLES.includes(user.role)) {
    return NextResponse.json({ error: "only owner or finance can set targets" }, { status: 403 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  deleteTarget(id);
  return NextResponse.json({ ok: true });
}
