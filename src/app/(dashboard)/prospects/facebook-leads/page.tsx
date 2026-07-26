"use client";

/**
 * Facebook / Instagram lead ads — the lead manager.
 *
 * Every lead the frame ingested from Meta, with the ad that produced it, the
 * company it resolved to, and its Pipedrive deal. Also surfaces the health of
 * the two moving parts: webhook ingest and the Conversions API queue that
 * reports funnel stages back to Meta.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HBars } from "@/components/dashboard/charts";
import { num, pct } from "@/components/dashboard/format";
import { seriesColor, STATUS } from "@/components/dashboard/palette";
import { RefreshCw, Facebook, AlertTriangle, CheckCircle2 } from "lucide-react";

type Lead = {
  leadgen_id: string; full_name: string | null; email: string | null; phone: string | null;
  campaign_name: string | null; ad_name: string | null; status: string; error: string | null;
  created_at: string; company_id: string | null; company_name: string | null; company_status: string | null;
  pipedrive_deal_id: number | null;
};
type Payload = {
  days: number;
  integration: { leadsConfigured: boolean; capiConfigured: boolean };
  totals: { total: number; withCompany: number; withDeal: number };
  byStatus: Array<{ status: string; n: number }>;
  byCampaign: Array<{ campaign: string; leads: number; converted: number }>;
  funnel: Array<{ event_name: string; n: number }>;
  capi: Array<{ status: string; n: number }>;
  leads: Lead[];
};

const RANGES = [7, 30, 90];
const STAGE_ORDER = ["Lead", "Contacted", "Qualified", "Converted"];
const STATUS_TONE: Record<string, string> = { processed: STATUS.good, received: STATUS.warn, error: STATUS.critical, skipped: STATUS.neutral };

export default function FacebookLeadsPage() {
  const [days, setDays] = useState(30);
  const [status, setStatus] = useState("all");
  const [nonce, setNonce] = useState(0);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/marketing/meta-leads?days=${days}&status=${status}`);
        const d = await res.json();
        if (!cancelled) setData(d.error ? null : d);
      } catch { /* keep prior */ } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [days, status, nonce]);

  const funnelMap = new Map((data?.funnel ?? []).map((f) => [f.event_name, f.n]));
  const notConfigured = data && !data.integration.leadsConfigured;

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Facebook &amp; Instagram leads</h1>
          <p className="text-sm text-muted-foreground">Lead-ad submissions, their ad attribution, and where they landed.</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border bg-background px-2 py-1.5 text-sm">
            <option value="all">All statuses</option>
            <option value="processed">Processed</option>
            <option value="received">Pending</option>
            <option value="error">Errored</option>
          </select>
          <div className="flex rounded-lg border p-0.5">
            {RANGES.map((d) => (
              <button key={d} onClick={() => setDays(d)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${days === d ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                {d}d
              </button>
            ))}
          </div>
          <Button variant="ghost" size="sm" onClick={() => setNonce((n) => n + 1)}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {notConfigured && (
        <div className="flex items-start gap-2 rounded-xl border p-4" style={{ backgroundColor: `${STATUS.warn}0f`, borderColor: `${STATUS.warn}55` }}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" style={{ color: STATUS.warn }} />
          <div className="text-sm">
            <p className="font-medium">Meta integration not connected yet</p>
            <p className="text-muted-foreground">
              Add the META_APP_SECRET, META_VERIFY_TOKEN, META_PAGE_TOKEN and META_CAPI_TOKEN environment variables, then
              subscribe the Page to the <code>leadgen</code> webhook. Leads will start flowing in automatically.
            </p>
          </div>
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Leads" value={num(data.totals.total)} icon={<Facebook className="h-4 w-4" />} accent={seriesColor(5)} />
            <Tile label="Matched to a company" value={num(data.totals.withCompany)} sub={data.totals.total ? pct((data.totals.withCompany / data.totals.total) * 100) : undefined} />
            <Tile label="Pushed to Pipedrive" value={num(data.totals.withDeal)} sub={data.totals.total ? pct((data.totals.withDeal / data.totals.total) * 100) : undefined} />
            <Tile
              label="Reported to Meta"
              value={num((data.capi.find((c) => c.status === "sent")?.n) ?? 0)}
              sub={`${num((data.capi.find((c) => c.status === "pending")?.n) ?? 0)} queued`}
              icon={data.integration.capiConfigured ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
              accent={data.integration.capiConfigured ? STATUS.good : STATUS.warn}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-xl border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold">Funnel reported to Meta</h2>
              <HBars
                rows={STAGE_ORDER.map((s, i) => ({ label: s, value: funnelMap.get(s) ?? 0, color: seriesColor(i % 6) }))}
                format={(v) => num(v)}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                These stages are pushed to Meta&apos;s Conversions API so ad delivery optimises toward leads that actually convert.
              </p>
            </section>
            <section className="rounded-xl border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold">By campaign</h2>
              {data.byCampaign.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">No leads in this range</p>
              ) : (
                <HBars
                  rows={data.byCampaign.map((c, i) => ({
                    label: c.campaign, value: c.leads, sub: `${num(c.converted)} ordered`, color: seriesColor(i % 6),
                  }))}
                  format={(v) => num(v)}
                />
              )}
            </section>
          </div>

          <section className="rounded-xl border">
            <header className="flex items-center gap-2 border-b px-4 py-2.5">
              <h2 className="flex-1 text-sm font-semibold">Leads</h2>
              <span className="text-xs text-muted-foreground">{data.leads.length} shown</span>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Lead</th>
                    <th className="px-2 py-2 text-left font-medium">Contact</th>
                    <th className="px-2 py-2 text-left font-medium">Campaign / ad</th>
                    <th className="px-2 py-2 text-left font-medium">Company</th>
                    <th className="px-2 py-2 text-left font-medium">Status</th>
                    <th className="px-2 py-2 text-right font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {data.leads.length === 0 ? (
                    <tr><td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">No leads in this range</td></tr>
                  ) : (
                    data.leads.map((l) => (
                      <tr key={l.leadgen_id} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="px-3 py-2 font-medium">{l.full_name || "—"}</td>
                        <td className="px-2 py-2 text-xs text-muted-foreground">
                          {l.email && <div className="truncate">{l.email}</div>}
                          {l.phone && <div>{l.phone}</div>}
                        </td>
                        <td className="px-2 py-2 text-xs">
                          <div className="truncate">{l.campaign_name || "—"}</div>
                          {l.ad_name && <div className="truncate text-muted-foreground">{l.ad_name}</div>}
                        </td>
                        <td className="px-2 py-2">
                          {l.company_id ? (
                            <Link href={`/prospects/${l.company_id}`} className="text-primary hover:underline">
                              {l.company_name || "View"}
                            </Link>
                          ) : <span className="text-muted-foreground">—</span>}
                          {l.pipedrive_deal_id && <Badge variant="outline" className="ml-1 text-[10px]">deal</Badge>}
                        </td>
                        <td className="px-2 py-2">
                          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize"
                            style={{ backgroundColor: `${STATUS_TONE[l.status] ?? STATUS.neutral}1a`, color: STATUS_TONE[l.status] ?? STATUS.neutral }}
                            title={l.error ?? undefined}>
                            {l.status}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-right text-xs text-muted-foreground">{(l.created_at || "").slice(0, 10)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub, icon, accent }: { label: string; value: string; sub?: string; icon?: React.ReactNode; accent?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        {icon && <span className="rounded-md p-1" style={accent ? { backgroundColor: `${accent}1a`, color: accent } : undefined}>{icon}</span>}
      </div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
