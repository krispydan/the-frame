"use client";

/**
 * Color performance — which colorways sell, and when.
 *
 * Style and color are separate buying decisions: the factory offers a frame in
 * N colors and we choose the split. Product-level reporting can't answer "are
 * we over-buying tortoise", because a hit style hides a dead color inside it.
 *
 * The seasonality half is the reason this page exists. A flat annual ranking
 * will cheerfully tell you to buy a color in the month it stops selling, so
 * the month × color heatmap sits above the table and every row carries its
 * peak month and a seasonality multiple.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Delta } from "@/components/dashboard/delta";
import { money, num, pct } from "@/components/dashboard/format";
import { seriesColor, STATUS } from "@/components/dashboard/palette";
import { ArrowUpDown, Download, RefreshCw, Palette, Snowflake, CalendarClock } from "lucide-react";

type Row = {
  color: string;
  units: number; revenue: number;
  unitsWholesale: number; unitsRetail: number; wholesaleSharePct: number;
  unitSharePct: number;
  products: number; accounts: number; avgOrderQty: number; orderLines: number;
  unitsRecent: number; unitsPrior: number; trendPct: number | null; trend: string;
  onHand: number; onOrder: number; weeksCover: number | null;
  byMonth: Array<{ month: string; units: number; revenue: number }>;
  peakMonth: string | null; seasonalityIndex: number | null;
};
type Payload = {
  windowDays: number;
  months: string[];
  totals: { units: number; revenue: number; colors: number; onHand: number; onOrder: number };
  rows: Row[];
};

type SortKey = "units" | "revenue" | "unitSharePct" | "trendPct" | "onHand" | "onOrder" | "weeksCover" | "seasonalityIndex" | "accounts";

const WINDOWS = [
  { days: 180, label: "6m" },
  { days: 365, label: "12m" },
  { days: 730, label: "24m" },
];

/** "2026-03" → "Mar 26" */
function monthLabel(ym: string): string {
  const m = parseInt(ym.slice(5, 7), 10);
  const name = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m] ?? ym;
  return `${name} ${ym.slice(2, 4)}`;
}
function monthShort(ym: string): string {
  const m = parseInt(ym.slice(5, 7), 10);
  return ["", "J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"][m] ?? "?";
}

export default function ColorPerformancePage() {
  const [days, setDays] = useState(365);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<SortKey>("units");
  const [asc, setAsc] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/v1/inventory/color-performance?days=${days}`)
      .then((r) => r.json())
      .then((d) => setData(d.error ? null : d))
      .finally(() => setLoading(false));
  }, [days]);

  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    if (!data) return [];
    return [...data.rows].sort((a, b) => {
      const av = (a[sort] ?? -Infinity) as number;
      const bv = (b[sort] ?? -Infinity) as number;
      return asc ? av - bv : bv - av;
    });
  }, [data, sort, asc]);

  const months = data?.months ?? [];

  // Heatmap covers the colors that matter; a 40-row grid reads as noise.
  const heatRows = useMemo(() => (data?.rows ?? []).filter((r) => r.units > 0).slice(0, 12), [data]);

  /** Colors holding stock with zero sales in the window — the clearest over-buy. */
  const stale = useMemo(
    () => (data?.rows ?? []).filter((r) => r.units === 0 && r.onHand + r.onOrder > 0)
      .sort((a, b) => b.onHand + b.onOrder - (a.onHand + a.onOrder)).slice(0, 6),
    [data],
  );
  /** Genuinely seasonal colors — buy timing matters more than buy size here. */
  const seasonal = useMemo(
    () => (data?.rows ?? []).filter((r) => r.units >= 20 && (r.seasonalityIndex ?? 0) >= 1.5)
      .sort((a, b) => (b.seasonalityIndex ?? 0) - (a.seasonalityIndex ?? 0)).slice(0, 6),
    [data],
  );

  const th = (key: SortKey, label: string) => (
    <th className="px-2 py-2 text-right font-medium">
      <button
        className="inline-flex items-center gap-1 hover:text-foreground"
        onClick={() => { if (sort === key) setAsc((v) => !v); else { setSort(key); setAsc(false); } }}
      >
        {label} <ArrowUpDown className={`h-3 w-3 ${sort === key ? "text-foreground" : "text-muted-foreground/50"}`} />
      </button>
    </th>
  );

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Color performance</h1>
          <p className="text-sm text-muted-foreground">
            Which colorways sell, how much stock each is carrying, and which months they peak in.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border p-0.5">
            {WINDOWS.map((w) => (
              <button
                key={w.days}
                onClick={() => setDays(w.days)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${days === w.days ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {w.label}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button variant="outline" size="sm" render={<a href={`/api/v1/inventory/color-performance?days=${days}&format=csv`} />}>
            <Download className="mr-1.5 h-3.5 w-3.5" /> CSV
          </Button>
          <Button variant="ghost" size="sm" render={<Link href="/inventory/performance" />}>By product</Button>
        </div>
      </div>

      {data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Tile label="Units sold" value={num(data.totals.units)} />
          <Tile label="Revenue" value={money(data.totals.revenue, { compact: data.totals.revenue >= 100000 })} />
          <Tile label="Colors sold" value={num(data.totals.colors)} />
          <Tile label="On hand" value={num(data.totals.onHand)} sub="units, all colors" />
          <Tile label="On order" value={num(data.totals.onOrder)} sub="units on open POs" />
        </div>
      )}

      {/* Seasonality heatmap — the "when" question */}
      <section className="rounded-xl border bg-card">
        <header className="flex items-center gap-2 border-b px-4 py-2.5">
          <span className="rounded-md p-1" style={{ backgroundColor: `${seriesColor(0)}1a`, color: seriesColor(0) }}>
            <CalendarClock className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-tight">When each color sells</h2>
            <p className="text-xs text-muted-foreground">
              Units per month, shaded against that color&apos;s own best month — so each row shows its own shape, not just its size.
            </p>
          </div>
        </header>
        <div className="overflow-x-auto p-4">
          {loading && !data ? (
            <div className="h-40 animate-pulse rounded bg-muted" />
          ) : heatRows.length === 0 || months.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No color sales in this window</p>
          ) : (
            <table className="min-w-[640px] border-separate border-spacing-[2px] text-xs">
              <thead>
                <tr>
                  <th className="sticky left-0 bg-card pr-2 text-left font-medium text-muted-foreground">Color</th>
                  {months.map((m) => (
                    <th key={m} className="w-6 pb-1 text-center font-medium text-muted-foreground" title={monthLabel(m)}>
                      {monthShort(m)}
                    </th>
                  ))}
                  <th className="pl-2 text-right font-medium text-muted-foreground">Peak</th>
                </tr>
              </thead>
              <tbody>
                {heatRows.map((r, i) => {
                  const peak = Math.max(...r.byMonth.map((p) => p.units), 1);
                  const hue = seriesColor(i);
                  return (
                    <tr key={r.color}>
                      <td className="sticky left-0 max-w-[140px] truncate bg-card pr-2 font-medium" title={r.color}>
                        {r.color}
                      </td>
                      {r.byMonth.map((p) => {
                        // Opacity ramp within the row's own hue: keeps identity
                        // per color while showing intensity per month. A zero
                        // month stays visibly empty rather than faint.
                        const ratio = p.units / peak;
                        return (
                          <td
                            key={p.month}
                            className="h-6 w-6 rounded-sm text-center"
                            style={{
                              backgroundColor: p.units === 0 ? "var(--muted)" : hue,
                              opacity: p.units === 0 ? 0.35 : 0.25 + ratio * 0.75,
                            }}
                            title={`${r.color} · ${monthLabel(p.month)}: ${num(p.units)} units`}
                          />
                        );
                      })}
                      <td className="whitespace-nowrap pl-2 text-right tabular-nums text-muted-foreground">
                        {r.peakMonth ? monthLabel(r.peakMonth) : "—"}
                        {(r.seasonalityIndex ?? 0) >= 1.5 && (
                          <span className="ml-1" style={{ color: STATUS.serious }}>{r.seasonalityIndex?.toFixed(1)}x</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* Decision callouts */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Callout
          title="Seasonal colors"
          hint="Peak month is well above their average — time the buy, don't just size it"
          icon={<CalendarClock className="h-4 w-4" />}
          tone={STATUS.warn}
          rows={seasonal.map((r) => ({
            key: r.color,
            main: r.color,
            meta: `peaks ${r.peakMonth ? monthLabel(r.peakMonth) : "—"} at ${r.seasonalityIndex?.toFixed(1)}x its average month · ${num(r.units)} units`,
          }))}
        />
        <Callout
          title="Holding stock, not selling"
          hint="No units sold in this window but stock on hand or inbound"
          icon={<Snowflake className="h-4 w-4" />}
          tone={STATUS.critical}
          rows={stale.map((r) => ({
            key: r.color,
            main: r.color,
            meta: `${num(r.onHand)} on hand${r.onOrder > 0 ? ` · ${num(r.onOrder)} still inbound` : ""}`,
          }))}
        />
      </div>

      {/* Full table */}
      <div className="rounded-xl border bg-card">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Palette className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">All colors</span>
          <span className="ml-auto text-xs text-muted-foreground">{rows.length} colors</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Color</th>
                {th("units", "Units")}
                {th("unitSharePct", "Share")}
                {th("revenue", "Revenue")}
                <th className="px-2 py-2 text-left font-medium">W / R split</th>
                {th("accounts", "Doors")}
                {th("trendPct", "Trend")}
                {th("onHand", "On hand")}
                {th("onOrder", "On order")}
                {th("weeksCover", "Cover")}
                {th("seasonalityIndex", "Peak")}
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}><td colSpan={11} className="px-3 py-3"><div className="h-4 animate-pulse rounded bg-muted" /></td></tr>
                ))
              ) : rows.length === 0 ? (
                <tr><td colSpan={11} className="px-3 py-10 text-center text-muted-foreground">No color data in this window</td></tr>
              ) : (
                rows.map((r, i) => (
                  <tr key={r.color} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1.5">
                        <i className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: seriesColor(i) }} />
                        <span className="font-medium">{r.color}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {num(r.products)} {r.products === 1 ? "style" : "styles"}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{num(r.units)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{r.units > 0 ? pct(r.unitSharePct) : "—"}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(r.revenue, { compact: r.revenue >= 10000 })}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-xs text-muted-foreground">
                      {r.units > 0 ? `${num(r.unitsWholesale)} / ${num(r.unitsRetail)}` : "—"}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{r.accounts > 0 ? num(r.accounts) : "—"}</td>
                    <td className="px-2 py-2 text-right">
                      {r.trend === "new" ? <Badge variant="secondary" className="text-[10px]">new</Badge> : <Delta value={r.trendPct} />}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{num(r.onHand)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {r.onOrder > 0 ? num(r.onOrder) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {r.weeksCover == null ? "—" : (
                        <span style={r.weeksCover > 52 ? { color: STATUS.serious, fontWeight: 500 } : undefined}>
                          {r.weeksCover}w
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-xs">
                      {r.peakMonth ? monthLabel(r.peakMonth) : "—"}
                      {(r.seasonalityIndex ?? 0) >= 1.5 && (
                        <span className="ml-1" style={{ color: STATUS.serious }}>{r.seasonalityIndex?.toFixed(1)}x</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Colors are taken from the catalog color name, normalized for casing so one color doesn&apos;t split into several rows —
        qualifiers are kept (&ldquo;Matte Black&rdquo; is its own color, not &ldquo;Black&rdquo;). Units are pack-expanded and rolled up to the
        colorway, so they agree with the product report and the demand forecast. On order counts units on POs not yet received.
        Cover is weeks of on-hand plus inbound at this window&apos;s average rate. Seasonality is the peak month&apos;s units as a
        multiple of the average month — above 1.5x is worth timing a buy around.
      </p>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Callout({
  title, hint, icon, tone, rows,
}: {
  title: string; hint: string; icon: React.ReactNode; tone: string;
  rows: Array<{ key: string; main: string; meta: string }>;
}) {
  return (
    <section className="rounded-xl border bg-card">
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <span className="rounded-md p-1" style={{ backgroundColor: `${tone}1a`, color: tone }}>{icon}</span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-tight">{title}</h3>
          <p className="truncate text-xs text-muted-foreground">{hint}</p>
        </div>
      </header>
      <div className="p-3">
        {rows.length === 0 ? (
          <p className="py-3 text-center text-xs text-muted-foreground">Nothing here right now</p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li key={r.key} className="text-sm">
                <div className="truncate font-medium">{r.main}</div>
                <div className="text-xs text-muted-foreground">{r.meta}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
