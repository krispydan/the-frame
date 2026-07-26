"use client";

/**
 * Outreach analytics — every top-of-funnel channel in one place: cold calls,
 * cold email, paid-social leads and direct mail, plus the funnel from first
 * touch through interested to paying customer.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AreaTrend, HBars, Meter } from "@/components/dashboard/charts";
import { Delta } from "@/components/dashboard/delta";
import { num, pct } from "@/components/dashboard/format";
import { seriesColor, STATUS } from "@/components/dashboard/palette";
import { RefreshCw, Phone, Mail, Facebook, Mailbox, ArrowUpRight } from "lucide-react";

type Payload = {
  days: number;
  calls: {
    total: number; connected: number; connectRate: number; priorConnectRate: number; priorTotal: number;
    byDay: Array<{ d: string; dials: number; connects: number }>;
    dispositions: Array<{ label: string; n: number }>;
    agents: Array<{ agent: string; dials: number; connects: number }>;
  };
  email: {
    sent: number; replies: number; interested: number; bounced: number; replyRate: number;
    byCampaign: Array<{ campaign: string; sent: number; replies: number; interested: number }>;
  };
  metaLeads: { total: number; processed: number };
  directMail: number;
  funnel: { touched: number; interested: number; customers: number };
};

const RANGES = [7, 30, 90];

export default function OutreachPage() {
  const [days, setDays] = useState(30);
  const [nonce, setNonce] = useState(0);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/marketing/outreach?days=${days}`);
        const d = await res.json();
        if (!cancelled) setData(d.error ? null : d);
      } catch { /* keep prior */ } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [days, nonce]);

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Outreach</h1>
          <p className="text-sm text-muted-foreground">Calls, email, paid social and direct mail — and what they turn into.</p>
        </div>
        <div className="flex items-center gap-2">
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

      {!data ? (
        <div className="grid gap-4 md:grid-cols-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-48 animate-pulse rounded-xl border bg-muted/40" />)}</div>
      ) : (
        <>
          {/* Channel summary */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile icon={<Phone className="h-4 w-4" />} label="Dials" value={num(data.calls.total)} sub={`${pct(data.calls.connectRate)} connected`} accent={seriesColor(0)} />
            <Tile icon={<Mail className="h-4 w-4" />} label="Emails sent" value={num(data.email.sent)} sub={`${pct(data.email.replyRate)} replied`} accent={seriesColor(2)} />
            <Tile icon={<Facebook className="h-4 w-4" />} label="Meta leads" value={num(data.metaLeads.total)} sub={`${num(data.metaLeads.processed)} synced`} accent={seriesColor(5)} href="/prospects/facebook-leads" />
            <Tile icon={<Mailbox className="h-4 w-4" />} label="Catalogs mailed" value={num(data.directMail)} sub="all time" accent={seriesColor(1)} />
          </div>

          {/* Funnel */}
          <section className="rounded-xl border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">Funnel</h2>
            <HBars
              rows={[
                { label: "Touched this period", value: data.funnel.touched, color: seriesColor(0) },
                { label: "Interested / catalog sent", value: data.funnel.interested, color: seriesColor(3) },
                { label: "Became customers", value: data.funnel.customers, color: STATUS.good },
              ]}
              format={(v) => num(v)}
            />
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Calls */}
            <section className="rounded-xl border bg-card">
              <header className="flex items-center gap-2 border-b px-4 py-2.5">
                <Phone className="h-4 w-4 text-muted-foreground" />
                <h2 className="flex-1 text-sm font-semibold">Cold calls</h2>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  vs prior <Delta value={data.calls.connectRate - data.calls.priorConnectRate} suffix="pt" />
                </span>
              </header>
              <div className="space-y-4 p-4">
                <Meter value={data.calls.connectRate} label="connect rate" color={seriesColor(0)}
                  sub={`${num(data.calls.connected)} connected of ${num(data.calls.total)} dials`} />
                {data.calls.byDay.length > 1 && (
                  <div>
                    <div className="mb-1 text-xs text-muted-foreground">Dials per day</div>
                    <AreaTrend data={data.calls.byDay.map((r) => ({ label: r.d, value: r.dials }))} color={seriesColor(0)} height={120} format={(v) => `${Math.round(v)} dials`} />
                  </div>
                )}
                {data.calls.dispositions.length > 0 && (
                  <div>
                    <div className="mb-1 text-xs text-muted-foreground">Top dispositions</div>
                    <HBars rows={data.calls.dispositions.slice(0, 6).map((d, i) => ({ label: d.label, value: d.n, color: seriesColor(i % 6) }))} format={(v) => num(v)} />
                  </div>
                )}
              </div>
            </section>

            {/* Email */}
            <section className="rounded-xl border bg-card">
              <header className="flex items-center gap-2 border-b px-4 py-2.5">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <h2 className="flex-1 text-sm font-semibold">Cold email</h2>
                <Link href="/campaigns" className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground">
                  Campaigns <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
              </header>
              <div className="space-y-4 p-4">
                <Meter value={data.email.replyRate} label="reply rate" color={seriesColor(2)}
                  sub={`${num(data.email.replies)} replies · ${num(data.email.interested)} interested · ${num(data.email.bounced)} bounced`} />
                {data.email.byCampaign.length > 0 && (
                  <div>
                    <div className="mb-1 text-xs text-muted-foreground">By campaign (sent)</div>
                    <HBars rows={data.email.byCampaign.map((c, i) => ({
                      label: c.campaign, value: c.sent, sub: `${num(c.replies)} replies`, color: seriesColor(i % 6),
                    }))} format={(v) => num(v)} />
                  </div>
                )}
              </div>
            </section>
          </div>

          {/* Agents */}
          {data.calls.agents.length > 0 && (
            <section className="rounded-xl border bg-card">
              <header className="border-b px-4 py-2.5"><h2 className="text-sm font-semibold">By agent</h2></header>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Agent</th>
                      <th className="px-3 py-2 text-right font-medium">Dials</th>
                      <th className="px-3 py-2 text-right font-medium">Connected</th>
                      <th className="px-3 py-2 text-right font-medium">Connect rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.calls.agents.map((a) => {
                      const rate = a.dials ? (a.connects / a.dials) * 100 : 0;
                      return (
                        <tr key={a.agent} className="border-b last:border-0">
                          <td className="px-3 py-2">{a.agent}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{num(a.dials)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{num(a.connects)}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-medium">{pct(rate)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Tile({ icon, label, value, sub, accent, href }: { icon: React.ReactNode; label: string; value: string; sub?: string; accent?: string; href?: string }) {
  const body = (
    <div className="rounded-xl border bg-card p-4 transition-shadow hover:shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="rounded-md p-1" style={accent ? { backgroundColor: `${accent}1a`, color: accent } : undefined}>{icon}</span>
      </div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}
