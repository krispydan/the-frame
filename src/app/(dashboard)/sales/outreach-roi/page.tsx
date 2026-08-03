"use client";

/**
 * Outreach ROI — is a rep's calling paying for itself?
 *
 * Built to answer a spending decision, so it leads with the number that
 * decides it (gross-profit ROI vs 1.0) and shows the two things that most
 * often make that number a lie:
 *
 *   1. The warm/cold split. 96% of the first month's attributed revenue came
 *      from AJ Morgan customers who already had a buying relationship —
 *      reading the blended figure alone would have credited cold calling with
 *      revenue it didn't produce.
 *   2. The control group. "They'd have ordered anyway" is testable by
 *      comparing called vs uncalled customers from the same list.
 *
 * The open-appointment backlog sits alongside, because "the calling doesn't
 * work" and "the follow-up doesn't happen" look identical in a conversion rate
 * and need opposite fixes.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { money, num, pct } from "@/components/dashboard/format";
import { seriesColor, STATUS } from "@/components/dashboard/palette";
import {
  RefreshCw, Download, PhoneCall, TrendingUp, AlertTriangle, Users, FlaskConical, Info,
} from "lucide-react";

type Row = {
  companyId: string; companyName: string | null; status: string;
  firstCallAt: string | null; lastCallAt: string | null;
  calls: number; connects: number; setAppointment: number;
  ordersAfter: number; revenueAfter: number; firstOrderAfterAt: string | null;
  daysCallToOrder: number | null; hadPriorOrders: boolean; revenueBefore: number;
  leadSource: string; isAjm: boolean; ajmTotalSpend: number | null;
};
type Payload = {
  rep: string; chosenAgent: string;
  roster: Array<{ agent: string; calls: number; firstCall: string; lastCall: string }>;
  windowStart: string; windowEnd: string; months: number;
  monthlyCost: number; totalCost: number;
  activity: { calls: number; connects: number; connectRatePct: number; talkMinutes: number;
    companiesTouched: number; setAppointments: number; appointmentRatePct: number; companiesWithAppointment: number };
  outcome: { newCustomers: number; newRevenue: number; reactivatedCustomers: number; reactivatedRevenue: number;
    totalAttributedRevenue: number; orders: number; avgOrderValue: number;
    appointmentToOrderPct: number; callToOrderPct: number };
  attribution: { ajmBuyers: number; ajmRevenue: number; nonAjmBuyers: number; nonAjmRevenue: number;
    ajmSharePct: number; coldOnlyRevenueRoi: number; coldOnlyGrossProfitRoi: number;
    ajmCompaniesCalled: number; ajmCallShare: number; ajmOrderRatePct: number; coldOrderRatePct: number;
    bySource: Array<{ source: string; called: number; buyers: number; revenue: number; orderRatePct: number }> };
  economics: { revenueRoi: number; grossProfitRoi: number; assumedGrossMarginPct: number; grossProfit: number;
    costPerConnect: number; costPerAppointment: number; costPerNewCustomer: number | null;
    breakEvenRevenue: number; revenueVsBreakEven: number };
  byMonth: Array<{ month: string; calls: number; connects: number; appointments: number;
    orders: number; revenue: number; cost: number }>;
  wins: Row[];
  openAppointments: Row[];
  control: {
    called: { companies: number; buyers: number; revenue: number; orderRatePct: number; revenuePerCompany: number; avgPriorSpend: number };
    notCalled: { companies: number; buyers: number; revenue: number; orderRatePct: number; revenuePerCompany: number; avgPriorSpend: number };
    liftPct: number;
  };
};

const SOURCE_LABEL: Record<string, string> = {
  ajm: "AJ Morgan (warm)",
  "imported-list": "Imported list (cold)",
  "facebook-ads": "Facebook ads",
  "cold-email": "Cold email",
  faire: "Faire",
  other: "Other",
  unknown: "Unknown",
};

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
}

export default function OutreachRoiPage() {
  const [agent, setAgent] = useState("");
  const [cost, setCost] = useState("2500");
  const [since, setSince] = useState("");
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (agent) p.set("agent", agent);
    if (cost) p.set("cost", cost);
    if (since) p.set("since", since);
    return p.toString();
  }, [agent, cost, since]);

  // Every setState lands after an await, never synchronously inside the
  // effect — the React compiler flags the synchronous form as a cascading
  // render.
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/sales/rep-roi?${query}`);
      const d = await res.json();
      if (d.error) { setError(d.error); setData(null); }
      else { setError(null); setData(d); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  const roi = data?.economics.grossProfitRoi ?? 0;
  const coldRoi = data?.attribution.coldOnlyGrossProfitRoi ?? 0;
  // 1.0 is the line: below it, the rep costs more than the gross profit they
  // generate. Colour is backed by the label, never carried alone.
  const roiTone = roi >= 1.5 ? STATUS.good : roi >= 1 ? STATUS.warn : STATUS.critical;

  const staleAppts = useMemo(
    () => (data?.openAppointments ?? []).filter((a) => (daysSince(a.lastCallAt) ?? 0) > 14),
    [data],
  );

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Outreach ROI</h1>
          <p className="text-sm text-muted-foreground">
            Does a rep&apos;s calling generate more gross profit than they cost? Attributed from call logs and orders — nothing self-reported.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">Rep (PhoneBurner agent)</span>
            <select
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              className="h-8 rounded-md border bg-background px-2 text-sm"
            >
              {/* Empty value = "whatever the API picks", which is the busiest
                  agent. Selecting it explicitly would mean writing state during
                  the load effect. */}
              <option value="">{data?.chosenAgent ? `${data.chosenAgent} (default)` : "Loading…"}</option>
              {(data?.roster ?? []).filter((r) => r.agent !== data?.chosenAgent).map((r) => (
                <option key={r.agent} value={r.agent}>{r.agent} ({num(r.calls)} calls)</option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">Cost / month</span>
            <Input value={cost} onChange={(e) => setCost(e.target.value)} className="h-8 w-24" inputMode="numeric" />
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">Since</span>
            <Input type="date" value={since} onChange={(e) => setSince(e.target.value)} className="h-8 w-36" />
          </label>
          <Button variant="outline" size="sm" onClick={() => { setLoading(true); void load(); }} disabled={loading}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button variant="outline" size="sm" render={<a href={`/api/admin/sales/rep-roi?${query}&format=csv`} />}>
            <Download className="mr-1.5 h-3.5 w-3.5" /> CSV
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border p-3 text-sm" style={{ backgroundColor: `${STATUS.critical}0f`, borderColor: `${STATUS.critical}55` }}>
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="grid gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-muted" />)}
        </div>
      ) : data ? (
        <>
          {/* The verdict */}
          <section className="rounded-xl border bg-card p-5">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
              <div>
                <div className="text-xs text-muted-foreground">Gross-profit ROI</div>
                <div className="text-4xl font-semibold tabular-nums" style={{ color: roiTone }}>
                  {roi.toFixed(2)}×
                </div>
                <div className="text-xs" style={{ color: roiTone }}>
                  {roi >= 1 ? "Above break-even" : "Below break-even — costs more than it returns"}
                </div>
              </div>
              <div className="text-sm text-muted-foreground">
                <div>
                  {money(data.outcome.totalAttributedRevenue)} revenue · {money(data.economics.grossProfit)} gross profit
                  @ {data.economics.assumedGrossMarginPct}% margin
                </div>
                <div>
                  against {money(data.totalCost)} cost ({data.months} months @ {money(data.monthlyCost)}/mo)
                </div>
                <div>
                  Break-even needs {money(data.economics.breakEvenRevenue)} revenue —{" "}
                  <span style={{ color: data.economics.revenueVsBreakEven >= 0 ? STATUS.good : STATUS.critical }}>
                    {data.economics.revenueVsBreakEven >= 0 ? "clear by " : "short by "}
                    {money(Math.abs(data.economics.revenueVsBreakEven))}
                  </span>
                </div>
              </div>
            </div>
          </section>

          {/* Warm vs cold — the number that reframes the verdict */}
          <section className="rounded-xl border bg-card">
            <header className="flex items-center gap-2 border-b px-4 py-2.5">
              <span className="rounded-md p-1" style={{ backgroundColor: `${STATUS.warn}1a`, color: STATUS.warn }}>
                <Users className="h-4 w-4" />
              </span>
              <div>
                <h2 className="text-sm font-semibold leading-tight">Warm vs cold</h2>
                <p className="text-xs text-muted-foreground">
                  AJ Morgan customers already had a buying relationship. Crediting their orders to cold calling overstates it.
                </p>
              </div>
            </header>
            <div className="grid gap-4 p-4 sm:grid-cols-2">
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">Blended (everything)</div>
                <div className="text-2xl font-semibold tabular-nums">{roi.toFixed(2)}×</div>
                <div className="text-xs text-muted-foreground">
                  {data.outcome.orders} orders · {money(data.outcome.totalAttributedRevenue)}
                </div>
              </div>
              <div className="rounded-lg border p-3" style={{ borderColor: coldRoi < 1 ? `${STATUS.critical}55` : undefined }}>
                <div className="text-xs text-muted-foreground">Cold leads only</div>
                <div className="text-2xl font-semibold tabular-nums" style={{ color: coldRoi < 1 ? STATUS.critical : undefined }}>
                  {coldRoi.toFixed(2)}×
                </div>
                <div className="text-xs text-muted-foreground">
                  {data.attribution.nonAjmBuyers} buyers · {money(data.attribution.nonAjmRevenue)} ·{" "}
                  {pct(100 - data.attribution.ajmSharePct)} of revenue
                </div>
              </div>
            </div>
            <div className="overflow-x-auto border-t">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Lead source</th>
                    <th className="px-2 py-2 text-right font-medium">Called</th>
                    <th className="px-2 py-2 text-right font-medium">Buyers</th>
                    <th className="px-2 py-2 text-right font-medium">Revenue</th>
                    <th className="px-2 py-2 text-right font-medium">Order rate</th>
                  </tr>
                </thead>
                <tbody>
                  {data.attribution.bySource.map((s, i) => (
                    <tr key={s.source} className="border-t">
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-1.5">
                          <i className="h-2 w-2 rounded-sm" style={{ backgroundColor: seriesColor(i) }} />
                          {SOURCE_LABEL[s.source] ?? s.source}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{num(s.called)}</td>
                      <td className="px-2 py-2 text-right tabular-nums font-medium">{s.buyers}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{money(s.revenue)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{s.orderRatePct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Control group */}
          <section className="rounded-xl border bg-card">
            <header className="flex items-center gap-2 border-b px-4 py-2.5">
              <span className="rounded-md p-1" style={{ backgroundColor: `${seriesColor(0)}1a`, color: seriesColor(0) }}>
                <FlaskConical className="h-4 w-4" />
              </span>
              <div>
                <h2 className="text-sm font-semibold leading-tight">Would they have ordered anyway?</h2>
                <p className="text-xs text-muted-foreground">
                  AJ Morgan customers called vs never called, same window.
                </p>
              </div>
            </header>
            <div className="overflow-x-auto p-4">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium">Group</th>
                    <th className="px-2 py-1 text-right font-medium">Companies</th>
                    <th className="px-2 py-1 text-right font-medium">Buyers</th>
                    <th className="px-2 py-1 text-right font-medium">Order rate</th>
                    <th className="px-2 py-1 text-right font-medium">Revenue / company</th>
                    <th className="px-2 py-1 text-right font-medium">Avg prior AJM spend</th>
                  </tr>
                </thead>
                <tbody>
                  {([["Called", data.control.called], ["Not called", data.control.notCalled]] as const).map(([label, g]) => (
                    <tr key={label} className="border-t">
                      <td className="px-2 py-2 font-medium">{label}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{num(g.companies)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{num(g.buyers)}</td>
                      <td className="px-2 py-2 text-right tabular-nums font-semibold">{g.orderRatePct}%</td>
                      <td className="px-2 py-2 text-right tabular-nums">{money(g.revenuePerCompany)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{money(g.avgPriorSpend)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Lift is <strong>{data.control.liftPct} percentage points</strong>. Read it as an upper bound, not proof:
                  the called list was chosen rather than randomised, and if its average prior spend is higher then some of
                  the gap is selection rather than persuasion.
                </span>
              </p>
            </div>
          </section>

          {/* Activity + unit economics */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Calls" value={num(data.activity.calls)} sub={`${num(data.activity.connects)} connects · ${data.activity.connectRatePct}%`} icon={<PhoneCall className="h-4 w-4" />} />
            <Tile label="Appointments set" value={num(data.activity.setAppointments)} sub={`${data.activity.appointmentRatePct}% of connects`} />
            <Tile label="Cost per appointment" value={money(data.economics.costPerAppointment)} sub={`${money(data.economics.costPerConnect)} per connect`} />
            <Tile
              label="Cost per new customer"
              value={data.economics.costPerNewCustomer != null ? money(data.economics.costPerNewCustomer) : "—"}
              sub={`${money(data.outcome.avgOrderValue)} avg first order`}
              icon={<TrendingUp className="h-4 w-4" />}
            />
          </div>

          {/* The follow-up backlog */}
          <section className="rounded-xl border bg-card">
            <header className="flex items-center gap-2 border-b px-4 py-2.5">
              <span className="rounded-md p-1" style={{ backgroundColor: `${STATUS.serious}1a`, color: STATUS.serious }}>
                <AlertTriangle className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold leading-tight">
                  Appointments set, no order yet — {num(data.openAppointments.length)}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {num(staleAppts.length)} are more than 14 days old. At {money(data.outcome.avgOrderValue)} average
                  order, this backlog is worth ~{money(data.openAppointments.length * data.outcome.avgOrderValue)} if it converts.
                </p>
              </div>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Company</th>
                    <th className="px-2 py-2 text-left font-medium">Source</th>
                    <th className="px-2 py-2 text-right font-medium">Calls</th>
                    <th className="px-2 py-2 text-right font-medium">Last call</th>
                    <th className="px-2 py-2 text-right font-medium">Days ago</th>
                  </tr>
                </thead>
                <tbody>
                  {data.openAppointments.slice(0, 25).map((a) => {
                    const d = daysSince(a.lastCallAt);
                    return (
                      <tr key={a.companyId} className="border-t hover:bg-muted/30">
                        <td className="px-3 py-2">
                          <Link href={`/prospects/${a.companyId}`} className="font-medium text-primary hover:underline">
                            {a.companyName ?? "—"}
                          </Link>
                        </td>
                        <td className="px-2 py-2">
                          <Badge variant={a.isAjm ? "default" : "secondary"} className="text-[10px]">
                            {SOURCE_LABEL[a.leadSource] ?? a.leadSource}
                          </Badge>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{a.calls}</td>
                        <td className="px-2 py-2 text-right tabular-nums text-xs">{a.lastCallAt?.slice(0, 10) ?? "—"}</td>
                        <td className="px-2 py-2 text-right tabular-nums" style={(d ?? 0) > 14 ? { color: STATUS.serious, fontWeight: 500 } : undefined}>
                          {d ?? "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {data.openAppointments.length > 25 && (
              <p className="px-4 py-2 text-xs text-muted-foreground">
                Showing 25 of {num(data.openAppointments.length)} — full list in the CSV.
              </p>
            )}
          </section>

          {/* Wins */}
          <section className="rounded-xl border bg-card">
            <header className="border-b px-4 py-2.5">
              <h2 className="text-sm font-semibold leading-tight">Companies that ordered after a call</h2>
              <p className="text-xs text-muted-foreground">
                Only orders placed after the first call to that company count.
              </p>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Company</th>
                    <th className="px-2 py-2 text-left font-medium">Source</th>
                    <th className="px-2 py-2 text-right font-medium">Revenue</th>
                    <th className="px-2 py-2 text-right font-medium">Days call→order</th>
                    <th className="px-2 py-2 text-right font-medium">Prior AJM spend</th>
                  </tr>
                </thead>
                <tbody>
                  {data.wins.map((w) => (
                    <tr key={w.companyId} className="border-t hover:bg-muted/30">
                      <td className="px-3 py-2">
                        <Link href={`/prospects/${w.companyId}`} className="font-medium text-primary hover:underline">
                          {w.companyName ?? "—"}
                        </Link>
                      </td>
                      <td className="px-2 py-2">
                        <Badge variant={w.isAjm ? "default" : "secondary"} className="text-[10px]">
                          {SOURCE_LABEL[w.leadSource] ?? w.leadSource}
                        </Badge>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums font-medium">{money(w.revenueAfter)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{w.daysCallToOrder ?? "—"}d</td>
                      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                        {w.ajmTotalSpend ? money(w.ajmTotalSpend) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <p className="text-xs text-muted-foreground">
            Attribution is deliberately conservative: a company counts only if this agent called it, and only orders
            placed <em>after</em> the first call count. Window {data.windowStart.slice(0, 10)} to {data.windowEnd.slice(0, 10)},
            bounded by the call log — if the rep was paid before logging started, the real cost is higher than shown.
            Gross profit assumes a {data.economics.assumedGrossMarginPct}% margin.
          </p>
        </>
      ) : null}
    </div>
  );
}

function Tile({ label, value, sub, icon }: { label: string; value: string; sub?: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}{label}
      </div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
