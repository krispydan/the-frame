"use client";

/**
 * Targets — the plan, and how we're tracking against it.
 *
 * One row per metric: the number we committed to, what we've actually done,
 * where we should be by this point in the period, and where we'll land if
 * nothing changes. Editing is inline (owner/finance only); "copy last period"
 * fills a fresh period from the previous one's actuals so writing a plan takes
 * seconds rather than a spreadsheet.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { money, num, pct } from "@/components/dashboard/format";
import { STATUS } from "@/components/dashboard/palette";
import { ChevronLeft, ChevronRight, RefreshCw, Wand2, Check, Target as TargetIcon } from "lucide-react";

type Progress = {
  metric: string; label: string; unit: "currency" | "count" | "percent";
  scopeType: string; scopeId: string | null;
  periodStart: string; periodLabel: string;
  target: number | null; actual: number;
  attainmentPct: number | null; elapsedPct: number;
  expectedToDate: number | null; projected: number | null; projectedVsTargetPct: number | null;
  status: string; isComplete: boolean;
};
type Payload = {
  periodType: string; periodStart: string; prevPeriod: string; nextPeriod: string;
  canEdit: boolean;
  metrics: Array<{ id: string; label: string; unit: string; hint: string | null; isRate: boolean }>;
  progress: Progress[];
};

const STATUS_META: Record<string, { label: string; tone: string }> = {
  ahead:     { label: "Ahead",      tone: STATUS.good },
  on_track:  { label: "On track",   tone: STATUS.good },
  behind:    { label: "Behind",     tone: STATUS.warn },
  at_risk:   { label: "At risk",    tone: STATUS.critical },
  hit:       { label: "Hit",        tone: STATUS.good },
  missed:    { label: "Missed",     tone: STATUS.critical },
  no_target: { label: "No target",  tone: STATUS.neutral },
};

function fmt(value: number | null | undefined, unit: string): string {
  if (value == null) return "—";
  if (unit === "currency") return money(value, { compact: Math.abs(value) >= 100000 });
  if (unit === "percent") return pct(value, 1);
  return num(Math.round(value));
}

export default function TargetsPage() {
  const [periodStart, setPeriodStart] = useState<string | null>(null);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const qs = periodStart ? `?periodType=month&periodStart=${periodStart}` : "?periodType=month";
    (async () => {
      try {
        const res = await fetch(`/api/v1/targets${qs}`);
        const d = await res.json();
        if (!cancelled) { setData(d.error ? null : d); setDrafts({}); }
      } catch { /* keep prior */ } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [periodStart, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const saveAll = async () => {
    if (!data) return;
    const targets = Object.entries(drafts)
      .filter(([, v]) => v.trim() !== "")
      .map(([metric, v]) => ({
        metric, scopeType: "company", scopeId: null,
        periodType: "month", periodStart: data.periodStart, value: Number(v),
      }))
      .filter((t) => isFinite(t.value));
    if (targets.length === 0) return;
    setSaving(true);
    const res = await fetch("/api/v1/targets", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets }),
    });
    const d = await res.json();
    setSaving(false);
    if (res.ok && d.ok) { toast.success(`Saved ${d.saved} target${d.saved === 1 ? "" : "s"}`); reload(); }
    else toast.error(d.errors?.[0] ?? d.error ?? "Save failed");
  };

  const copyPrevious = async (growthPct: number) => {
    if (!data) return;
    setSaving(true);
    const res = await fetch("/api/v1/targets", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "copy-previous", periodType: "month", periodStart: data.periodStart, growthPct }),
    });
    const d = await res.json();
    setSaving(false);
    if (res.ok && d.ok) {
      toast.success(d.filled.length ? `Filled ${d.filled.length} targets from last month${growthPct ? ` +${growthPct}%` : ""}` : "Nothing to fill — targets already set");
      reload();
    } else toast.error(d.error ?? "Failed");
  };

  const company = (data?.progress ?? []).filter((p) => p.scopeType === "company");
  const scoped = (data?.progress ?? []).filter((p) => p.scopeType !== "company");
  const withTargets = company.filter((p) => p.target != null);
  const onTrack = withTargets.filter((p) => ["ahead", "on_track", "hit"].includes(p.status)).length;
  const dirty = Object.values(drafts).some((v) => v.trim() !== "");

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <TargetIcon className="h-6 w-6" /> Targets
          </h1>
          <p className="text-sm text-muted-foreground">The plan, and how we&apos;re tracking against it.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg border">
            <button className="px-2 py-1.5 text-muted-foreground hover:text-foreground" onClick={() => setPeriodStart(data?.prevPeriod ?? null)} aria-label="Previous month">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-[110px] px-2 text-center text-sm font-medium">
              {company[0]?.periodLabel ?? "…"}
            </span>
            <button className="px-2 py-1.5 text-muted-foreground hover:text-foreground" onClick={() => setPeriodStart(data?.nextPeriod ?? null)} aria-label="Next month">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <Button variant="ghost" size="sm" onClick={reload}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /></Button>
        </div>
      </div>

      {/* Summary */}
      {withTargets.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Targets set" value={`${withTargets.length} of ${company.length}`} />
          <Tile label="On track or better" value={`${onTrack}`} tone={onTrack === withTargets.length ? STATUS.good : undefined} sub={`of ${withTargets.length}`} />
          <Tile label="Period elapsed" value={pct((company[0]?.elapsedPct ?? 0) * 100)} />
          <Tile label="Needs attention" value={`${withTargets.filter((p) => ["behind", "at_risk", "missed"].includes(p.status)).length}`} tone={withTargets.some((p) => ["at_risk", "missed"].includes(p.status)) ? STATUS.critical : undefined} />
        </div>
      )}

      {/* Editor helpers */}
      {data?.canEdit && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
          <span className="text-muted-foreground">Quick fill:</span>
          <Button size="sm" variant="outline" disabled={saving} onClick={() => copyPrevious(0)}>
            <Wand2 className="mr-1 h-3.5 w-3.5" /> Last month&apos;s actuals
          </Button>
          <Button size="sm" variant="outline" disabled={saving} onClick={() => copyPrevious(10)}>+10%</Button>
          <Button size="sm" variant="outline" disabled={saving} onClick={() => copyPrevious(25)}>+25%</Button>
          <div className="flex-1" />
          {dirty && (
            <Button size="sm" onClick={saveAll} disabled={saving}>
              <Check className="mr-1 h-3.5 w-3.5" /> {saving ? "Saving…" : "Save changes"}
            </Button>
          )}
        </div>
      )}

      {/* Plan vs actual */}
      <div className="rounded-xl border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Metric</th>
                <th className="px-2 py-2 text-right font-medium">Target</th>
                <th className="px-2 py-2 text-right font-medium">Actual</th>
                <th className="px-2 py-2 text-left font-medium">Progress</th>
                <th className="px-2 py-2 text-right font-medium">Expected by now</th>
                <th className="px-2 py-2 text-right font-medium">Projected</th>
                <th className="px-2 py-2 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}><td colSpan={7} className="px-3 py-3"><div className="h-4 animate-pulse rounded bg-muted" /></td></tr>
                ))
              ) : (
                company.map((p) => {
                  const meta = STATUS_META[p.status] ?? STATUS_META.no_target;
                  const attain = p.attainmentPct ?? 0;
                  return (
                    <tr key={p.metric} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-3 py-2">
                        <div className="font-medium">{p.label}</div>
                        {data?.metrics.find((m) => m.id === p.metric)?.hint && (
                          <div className="text-xs text-muted-foreground">{data.metrics.find((m) => m.id === p.metric)!.hint}</div>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right">
                        {data?.canEdit ? (
                          <Input
                            value={drafts[p.metric] ?? (p.target != null ? String(p.target) : "")}
                            onChange={(e) => setDrafts((d) => ({ ...d, [p.metric]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === "Enter") saveAll(); }}
                            placeholder="—"
                            inputMode="decimal"
                            className="ml-auto h-8 w-28 text-right tabular-nums"
                          />
                        ) : (
                          <span className="tabular-nums">{fmt(p.target, p.unit)}</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right font-medium tabular-nums">{fmt(p.actual, p.unit)}</td>
                      <td className="px-2 py-2">
                        <div className="relative h-2 w-full min-w-[110px] overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, Math.max(0, attain))}%`, backgroundColor: meta.tone }} />
                          {/* Pace marker: where we should be by now */}
                          {p.target != null && !p.isComplete && (
                            <span className="absolute top-0 h-full w-0.5 bg-foreground/50" style={{ left: `${Math.min(100, p.elapsedPct * 100)}%` }} title="Where we should be by now" />
                          )}
                        </div>
                        <span className="text-[11px] text-muted-foreground tabular-nums">
                          {p.attainmentPct != null ? `${attain.toFixed(0)}% of target` : "no target set"}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{fmt(p.expectedToDate, p.unit)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {fmt(p.projected, p.unit)}
                        {p.projectedVsTargetPct != null && (
                          <span className="ml-1 text-[11px]" style={{ color: p.projectedVsTargetPct >= 0 ? STATUS.good : STATUS.critical }}>
                            {p.projectedVsTargetPct >= 0 ? "+" : ""}{p.projectedVsTargetPct.toFixed(0)}%
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
                          style={{ backgroundColor: `${meta.tone}1a`, color: meta.tone }}>
                          {meta.label}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {scoped.length > 0 && (
        <div className="rounded-xl border">
          <header className="border-b px-4 py-2.5"><h2 className="text-sm font-semibold">Scoped targets</h2></header>
          <ul className="divide-y">
            {scoped.map((p, i) => {
              const meta = STATUS_META[p.status] ?? STATUS_META.no_target;
              return (
                <li key={i} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                  <span><span className="font-medium">{p.label}</span> <span className="text-muted-foreground">· {p.scopeType}: {p.scopeId}</span></span>
                  <span className="flex items-center gap-3 tabular-nums">
                    <span>{fmt(p.actual, p.unit)} / {fmt(p.target, p.unit)}</span>
                    <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ backgroundColor: `${meta.tone}1a`, color: meta.tone }}>{meta.label}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Volume metrics (revenue, orders, units, leads) pace linearly through the period — the marker on each bar is where
        you should be today. Rate metrics (AOV, margin %, connect rate) are levels, so their expected value is simply the target.
        {data && !data.canEdit && " Only owner and finance roles can change targets."}
      </p>
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums" style={tone ? { color: tone } : undefined}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
