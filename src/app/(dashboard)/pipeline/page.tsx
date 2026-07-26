"use client";

/**
 * Pipeline analytics.
 *
 * Deals live in Pipedrive (the kanban board here was retired in favour of it),
 * but the frame keeps a projection of every deal in `pipedrive_deals`. That
 * makes this the right place to answer the questions the Pipedrive UI is bad
 * at: where value is concentrated by stage, what the win rate is, and which
 * deals have gone quiet. Every row deep-links out to Pipedrive or the prospect.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { HBars } from "@/components/dashboard/charts";
import { money, num, pct } from "@/components/dashboard/format";
import { seriesColor, STATUS } from "@/components/dashboard/palette";
import { RefreshCw, ExternalLink, Clock, Trophy } from "lucide-react";

type Payload = {
  apiDomain: string | null;
  totals: { open: number; won: number; lost: number; openValue: number; wonValue: number; winRate: number | null };
  byPipeline: Array<{ pipeline: string; deals: number; value: number }>;
  byStage: Array<{ pipeline: string; stage: string; deals: number; value: number }>;
  ageing: { fresh: number; week: number; month: number; stale: number };
  stalled: Array<{ deal_id: number; title: string; pipeline: string; stage: string; value: number; days: number; company_id: string | null; company_name: string | null }>;
  recentWins: Array<{ deal_id: number; title: string; value: number; updated_at: string; company_id: string | null; company_name: string | null }>;
};

export default function PipelinePage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/v1/sales/pipeline-analytics");
        const d = await res.json();
        if (!cancelled) setData(d.error ? null : d);
      } catch { /* keep prior */ } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [nonce]);

  const dealUrl = (id: number) => (data?.apiDomain ? `${data.apiDomain.replace(/\/$/, "")}/deal/${id}` : null);
  const pipelines = [...new Set((data?.byStage ?? []).map((s) => s.pipeline))];

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
          <p className="text-sm text-muted-foreground">
            Deal analytics from Pipedrive — work the deals themselves in Pipedrive or on each prospect page.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setNonce((n) => n + 1)}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          {data?.apiDomain && (
            <Button variant="outline" size="sm" render={<a href={`${data.apiDomain.replace(/\/$/, "")}/pipeline`} target="_blank" rel="noreferrer" />}>
              Open Pipedrive <ExternalLink className="ml-1 h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {!data ? (
        <div className="grid gap-4 md:grid-cols-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-40 animate-pulse rounded-xl border bg-muted/40" />)}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Open deals" value={num(data.totals.open)} />
            <Tile label="Open value" value={money(data.totals.openValue, { compact: true })} />
            <Tile label="Win rate" value={data.totals.winRate == null ? "—" : pct(data.totals.winRate)} sub={`${num(data.totals.won)} won · ${num(data.totals.lost)} lost`} tone={STATUS.good} />
            <Tile label="Gone quiet" value={num(data.ageing.month + data.ageing.stale)} sub="no movement 30d+" tone={data.ageing.stale > 0 ? STATUS.serious : undefined} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-xl border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold">Open value by pipeline</h2>
              <HBars
                rows={data.byPipeline.map((p, i) => ({ label: p.pipeline, value: p.value || p.deals, sub: `${num(p.deals)} deals`, color: seriesColor(i % 6) }))}
                format={(v) => money(v, { compact: true })}
              />
            </section>
            <section className="rounded-xl border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold">Deal ageing</h2>
              <HBars
                rows={[
                  { label: "Moved this week", value: data.ageing.fresh, color: STATUS.good },
                  { label: "8–30 days", value: data.ageing.week, color: seriesColor(0) },
                  { label: "31–90 days", value: data.ageing.month, color: STATUS.warn },
                  { label: "90+ days", value: data.ageing.stale, color: STATUS.critical },
                ]}
                format={(v) => num(v)}
              />
            </section>
          </div>

          {/* Stage funnel per pipeline */}
          {pipelines.map((p) => (
            <section key={p} className="rounded-xl border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold">{p} — open deals by stage</h2>
              <HBars
                rows={data.byStage.filter((s) => s.pipeline === p).map((s, i) => ({
                  label: s.stage, value: s.deals, sub: money(s.value, { compact: true }), color: seriesColor(i % 6),
                }))}
                format={(v) => num(v)}
              />
            </section>
          ))}

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-xl border">
              <header className="flex items-center gap-2 border-b px-4 py-2.5">
                <Clock className="h-4 w-4" style={{ color: STATUS.serious }} />
                <h2 className="text-sm font-semibold">Stalled deals</h2>
                <span className="ml-auto text-xs text-muted-foreground">no movement in 30+ days</span>
              </header>
              {data.stalled.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">Nothing stalled — nice.</p>
              ) : (
                <ul className="divide-y">
                  {data.stalled.map((d) => (
                    <li key={d.deal_id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                      <div className="min-w-0">
                        <div className="truncate font-medium">
                          {dealUrl(d.deal_id) ? (
                            <a href={dealUrl(d.deal_id)!} target="_blank" rel="noreferrer" className="hover:underline">{d.title || "Untitled deal"}</a>
                          ) : (d.title || "Untitled deal")}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {d.stage} · {d.company_id ? <Link href={`/prospects/${d.company_id}`} className="hover:underline">{d.company_name || "prospect"}</Link> : "—"}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="tabular-nums">{money(d.value, { compact: true })}</div>
                        <div className="text-xs" style={{ color: STATUS.serious }}>{d.days}d</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-xl border">
              <header className="flex items-center gap-2 border-b px-4 py-2.5">
                <Trophy className="h-4 w-4" style={{ color: STATUS.good }} />
                <h2 className="text-sm font-semibold">Recent wins</h2>
              </header>
              {data.recentWins.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">No won deals yet</p>
              ) : (
                <ul className="divide-y">
                  {data.recentWins.map((d) => (
                    <li key={d.deal_id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                      <div className="min-w-0">
                        <div className="truncate font-medium">
                          {dealUrl(d.deal_id) ? (
                            <a href={dealUrl(d.deal_id)!} target="_blank" rel="noreferrer" className="hover:underline">{d.title || "Untitled deal"}</a>
                          ) : (d.title || "Untitled deal")}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {d.company_id ? <Link href={`/prospects/${d.company_id}`} className="hover:underline">{d.company_name || "prospect"}</Link> : "—"}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="tabular-nums">{money(d.value, { compact: true })}</div>
                        <div className="text-xs text-muted-foreground">{(d.updated_at || "").slice(0, 10)}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
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
