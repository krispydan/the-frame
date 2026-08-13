export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import { apifyClient } from "@/modules/sales/lib/apify-client";

/**
 * Apify spend ledger — every run on the account, grouped by actor and by day.
 *
 * Exists because a surprising bill is never explained by the spend you already
 * track. Per-batch costs only cover runs our own code recorded; this reads the
 * account's run history, so work started by anything — a cron, another
 * session, a manual console run — shows up too.
 *
 * GET ?since=YYYY-MM-DD   → default: today (UTC)
 * GET ?limit=             → runs to scan back through (default 200)
 *
 * Read-only, and it queries run history rather than starting actors, so it
 * answers while the account is locked out on its usage limit.
 */
export async function GET(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;

  const p = req.nextUrl.searchParams;
  const since = p.get("since") || new Date().toISOString().slice(0, 10);
  const limit = Math.min(Number(p.get("limit")) || 200, 1000);

  const runs = await apifyClient.listRecentRuns(limit);
  const inWindow = runs.filter((r) => (r.startedAt ?? "") >= since);

  const names = new Map<string, string>();
  for (const actId of new Set(inWindow.map((r) => r.actId))) {
    names.set(actId, await apifyClient.getActorName(actId));
  }

  const byActor = new Map<string, { runs: number; usd: number; events: Record<string, number>; statuses: Record<string, number> }>();
  for (const r of inWindow) {
    const key = names.get(r.actId) ?? r.actId;
    const e = byActor.get(key) ?? { runs: 0, usd: 0, events: {}, statuses: {} };
    e.runs++;
    e.usd += r.usageTotalUsd ?? 0;
    e.statuses[r.status] = (e.statuses[r.status] ?? 0) + 1;
    for (const [k, v] of Object.entries(r.chargedEventCounts ?? {})) {
      if (Number(v)) e.events[k] = (e.events[k] ?? 0) + Number(v);
    }
    byActor.set(key, e);
  }

  const byDay = new Map<string, number>();
  for (const r of runs) {
    const day = (r.startedAt ?? "").slice(0, 10);
    if (day) byDay.set(day, (byDay.get(day) ?? 0) + (r.usageTotalUsd ?? 0));
  }

  const round = (n: number) => Math.round(n * 100) / 100;

  return NextResponse.json({
    ok: true,
    since,
    account: await apifyClient.getAccountUsage().catch((e) => ({ error: String(e) })),
    windowTotalUsd: round(inWindow.reduce((a, r) => a + (r.usageTotalUsd ?? 0), 0)),
    runsInWindow: inWindow.length,
    byActor: [...byActor.entries()]
      .map(([actor, v]) => ({ actor, runs: v.runs, usd: round(v.usd), statuses: v.statuses, events: v.events }))
      .sort((a, b) => b.usd - a.usd),
    byDay: [...byDay.entries()].map(([day, usd]) => ({ day, usd: round(usd) })).sort((a, b) => b.day.localeCompare(a.day)),
    // The individual big spenders, since one runaway run is a different problem
    // from a thousand small ones.
    topRuns: inWindow
      .filter((r) => (r.usageTotalUsd ?? 0) > 0)
      .sort((a, b) => (b.usageTotalUsd ?? 0) - (a.usageTotalUsd ?? 0))
      .slice(0, 20)
      .map((r) => ({
        id: r.id, actor: names.get(r.actId) ?? r.actId, status: r.status,
        startedAt: r.startedAt, usd: round(r.usageTotalUsd ?? 0), events: r.chargedEventCounts,
      })),
  });
}
