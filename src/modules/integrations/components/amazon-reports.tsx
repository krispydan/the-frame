"use client";

/**
 * Amazon reports — performance, products, replenishment.
 *
 * Three principles, all learned from the reference reports this mirrors:
 *
 * 1. **The written read-out goes above the table, not below it.** The numbers
 *    answer "what happened"; the sentences answer "so what". Most people read
 *    the first paragraph and stop, so it has to be the useful part.
 *
 * 2. **Giveaway sits next to paid, everywhere.** On this account a quarter of
 *    units take no money, and a table that shows only gross reads as a
 *    healthier business than the bank balance supports.
 *
 * 3. **Colour marks loss, not magnitude.** Red on every below-average cell
 *    trains people to ignore red. It is reserved for negative contribution
 *    and for a SKU whose volume is mostly giveaway.
 */

import { useState, useEffect, useCallback, Fragment } from "react";
import { RefreshCw, AlertTriangle, Info, TrendingUp, TrendingDown, PackagePlus, PackageMinus } from "lucide-react";

type Tab = "performance" | "products" | "replenishment";

interface MonthFigures {
  month: string; grossSales: number; giveaway: number; netSales: number;
  units: number; freeUnits: number; orders: number; aov: number;
  totalFees: number; refunds: number; cogs: number; seedingCost: number;
  contribution: number; contributionPct: number; sessions: number;
  conversionPct: number;
}
interface Performance {
  months: MonthFigures[];
  change: Record<string, { absolute: number; pct: number | null }> | null;
  adSpendAvailable: boolean;
  narrative: string[];
  provenance: string[];
}

interface AsinCell {
  month: string; netSales: number; giveaway: number; units: number;
  freeUnits: number; cogs: number; fees: number; contribution: number;
  marginPct: number | null; sessions: number; conversionPct: number | null;
}
interface AsinRow {
  sku: string; asin: string | null; title: string | null;
  months: AsinCell[]; totalNetSales: number; totalUnits: number;
  totalFreeUnits: number; totalContribution: number; totalMarginPct: number | null;
  landedCostPerUnit: number | null; lossMaking: boolean; mostlySeeded: boolean;
}
interface Profitability { months: string[]; rows: AsinRow[]; notes: string[] }

interface ReplenishLine {
  sku: string; title: string | null; amazonRecommendedQty: number;
  amazonUnitsSold30d: number; paidUnits30d: number; seededUnits30d: number;
  warehouseAvailable: number; fbaAvailable: number; fbaInbound: number;
  inFlight: number; proposedQty: number; shortfall: number;
  contributionPerUnit: number | null; flags: string[];
}
interface ExcessLine {
  sku: string; title: string | null; fbaAvailable: number; unfulfillable: number;
  paidUnits30d: number; seededUnits30d: number; daysOfCover: number | null;
  excessUnits: number; excessValueAtCost: number; reasons: string[];
}
interface Replenishment {
  replenishment: {
    snapshotDate: string | null; coverDays: number; lines: ReplenishLine[];
    totals: { skusConsidered: number; skusProposed: number; proposedUnits: number;
      shortfallUnits: number; amazonRecommendedUnits: number; proposedCost: number };
    warnings: string[];
  };
  excess: {
    lines: ExcessLine[];
    totals: { skusFlagged: number; excessUnits: number; excessValueAtCost: number; unfulfillableUnits: number };
    notes: string[];
  };
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const monthLabel = (m: string) => {
  const [y, mm] = m.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][mm - 1]} ${String(y).slice(2)}`;
};

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "performance", label: "Performance" },
  { key: "products", label: "Products" },
  { key: "replenishment", label: "Replenish" },
];

export function AmazonReports() {
  const [tab, setTab] = useState<Tab>("performance");
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/finance/amazon/reports?view=${tab}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Request failed");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-1 rounded-lg border p-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === t.key ? "bg-foreground text-background" : "hover:bg-muted"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm hover:bg-muted"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <div className="font-medium">Could not load this report</div>
          <div className="mt-1">{error}</div>
        </div>
      )}

      {loading && !data && (
        <div className="p-6 text-sm text-muted-foreground">Loading…</div>
      )}

      {!error && data && tab === "performance" && <PerformanceView p={data.performance as Performance} />}
      {!error && data && tab === "products" && <ProductsView p={data.profitability as Profitability} />}
      {!error && data && tab === "replenishment" && <ReplenishView d={data as unknown as Replenishment} />}
    </div>
  );
}

/** The written read-out. Deliberately the first thing on the page. */
function Narrative({ lines, tone = "info" }: { lines: string[]; tone?: "info" | "warn" }) {
  if (lines.length === 0) return null;
  const Icon = tone === "warn" ? AlertTriangle : Info;
  return (
    <div className={`rounded-lg border p-4 ${tone === "warn" ? "border-amber-200 bg-amber-50" : "border-blue-200 bg-blue-50"}`}>
      <div className="flex gap-2">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone === "warn" ? "text-amber-600" : "text-blue-600"}`} />
        <div className="space-y-2 text-sm leading-relaxed">
          {lines.map((l, i) => <p key={i} className={i === 0 ? "font-medium" : ""}>{l}</p>)}
        </div>
      </div>
    </div>
  );
}

function Provenance({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <details className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
      <summary className="cursor-pointer font-medium">What these numbers rest on</summary>
      <ul className="mt-2 space-y-1 list-disc pl-4">
        {lines.map((l, i) => <li key={i}>{l}</li>)}
      </ul>
    </details>
  );
}

function PerformanceView({ p }: { p: Performance }) {
  if (!p || p.months.length === 0) {
    return <div className="rounded-lg border p-6 text-sm text-muted-foreground">No Amazon activity yet.</div>;
  }

  const rows: Array<{ label: string; key: keyof MonthFigures; fmt: (n: number) => string; strong?: boolean; muted?: boolean }> = [
    { label: "Gross sales (list)", key: "grossSales", fmt: money },
    { label: "Giveaway (Vine)", key: "giveaway", fmt: money, muted: true },
    { label: "Paid sales", key: "netSales", fmt: money, strong: true },
    { label: "Units", key: "units", fmt: (n) => String(n) },
    { label: "— of which free", key: "freeUnits", fmt: (n) => String(n), muted: true },
    { label: "Orders", key: "orders", fmt: (n) => String(n) },
    { label: "AOV (paid)", key: "aov", fmt: money },
    { label: "Amazon fees", key: "totalFees", fmt: money },
    { label: "COGS (landed)", key: "cogs", fmt: money },
    { label: "Seeding cost", key: "seedingCost", fmt: money, muted: true },
    { label: "Contribution", key: "contribution", fmt: money, strong: true },
    { label: "Contribution %", key: "contributionPct", fmt: (n) => `${n}%`, strong: true },
    { label: "Sessions", key: "sessions", fmt: (n) => String(n) },
  ];

  return (
    <div className="space-y-4">
      <Narrative lines={p.narrative} />

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Metric</th>
              {p.months.map((m) => (
                <th key={m.month} className="px-3 py-2 text-right font-medium">{monthLabel(m.month)}</th>
              ))}
              {p.change && <th className="px-3 py-2 text-right font-medium">Change</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const ch = p.change?.[r.key as string];
              return (
                <tr key={r.key as string} className="border-t">
                  <td className={`px-3 py-1.5 ${r.strong ? "font-medium" : ""} ${r.muted ? "text-muted-foreground" : ""}`}>
                    {r.label}
                  </td>
                  {p.months.map((m) => (
                    <td key={m.month} className={`px-3 py-1.5 text-right tabular-nums ${r.strong ? "font-medium" : ""} ${
                      r.strong && r.key === "contribution" && m.contribution < 0 ? "text-red-600" : ""
                    } ${r.muted ? "text-muted-foreground" : ""}`}>
                      {r.fmt(m[r.key] as number)}
                    </td>
                  ))}
                  {p.change && (
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                      {ch
                        // A change from a zero base is undefined, not 100%.
                        // "new" says that; a number would look measured.
                        ? ch.pct === null ? (ch.absolute === 0 ? "—" : "new")
                          : <span className={ch.pct >= 0 ? "text-emerald-600" : "text-red-600"}>
                              {ch.pct >= 0 ? "+" : ""}{ch.pct}%
                            </span>
                        : "—"}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!p.adSpendAvailable && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <span className="font-medium">Contribution margin, not net profit.</span>{" "}
          Advertising is excluded — link the Amazon Ads account in Windsor to get ACOS, TACOS and true net profit.
        </div>
      )}
      <Provenance lines={p.provenance} />
    </div>
  );
}

function ProductsView({ p }: { p: Profitability }) {
  if (!p || p.rows.length === 0) {
    return <div className="rounded-lg border p-6 text-sm text-muted-foreground">No products sold in this window.</div>;
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Product</th>
              {p.months.map((m) => (
                <th key={m} colSpan={3} className="border-l px-3 py-2 text-center font-medium">{monthLabel(m)}</th>
              ))}
              <th className="border-l px-3 py-2 text-right font-medium">Total</th>
            </tr>
            <tr className="text-[10px]">
              <th />
              {p.months.map((m) => (
                // Keyed Fragment, not shorthand: a shorthand fragment cannot
                // carry a key, so React would warn and reconcile these three
                // cells by position across renders.
                <Fragment key={m}>
                  <th className="border-l px-2 py-1 text-right font-normal">Paid</th>
                  <th className="px-2 py-1 text-right font-normal">Units</th>
                  <th className="px-2 py-1 text-right font-normal">Margin</th>
                </Fragment>
              ))}
              <th className="border-l px-2 py-1 text-right font-normal">Contrib</th>
            </tr>
          </thead>
          <tbody>
            {p.rows.map((r) => (
              <tr key={r.sku} className={`border-t ${r.lossMaking ? "bg-red-50" : ""}`}>
                <td className="px-3 py-1.5">
                  <div className="font-medium">{r.title ?? r.sku}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.sku}
                    {r.landedCostPerUnit !== null && <> · cost ${r.landedCostPerUnit.toFixed(2)}</>}
                    {r.mostlySeeded && (
                      <span className="ml-1.5 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-800">
                        {Math.round((r.totalFreeUnits / r.totalUnits) * 100)}% giveaway
                      </span>
                    )}
                  </div>
                </td>
                {p.months.map((m) => {
                  const c = r.months.find((x) => x.month === m);
                  return (
                    <Fragment key={m}>
                      <td className="border-l px-2 py-1.5 text-right tabular-nums">
                        {c && c.netSales > 0 ? money(c.netSales) : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {c && c.units > 0
                          ? <>{c.units}{c.freeUnits > 0 && <span className="text-muted-foreground"> ({c.freeUnits}f)</span>}</>
                          : "—"}
                      </td>
                      <td className={`px-2 py-1.5 text-right tabular-nums ${
                        c?.marginPct != null && c.marginPct < 0 ? "font-medium text-red-600" : ""
                      }`}>
                        {/* Null margin means no paid sales that month — a dash,
                            not 0%, which would read as break-even. */}
                        {c?.marginPct != null ? `${c.marginPct}%` : "—"}
                      </td>
                    </Fragment>
                  );
                })}
                <td className={`border-l px-2 py-1.5 text-right font-medium tabular-nums ${r.totalContribution < 0 ? "text-red-600" : ""}`}>
                  {money(r.totalContribution)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Provenance lines={p.notes} />
    </div>
  );
}

function ReplenishView({ d }: { d: Replenishment }) {
  const r = d.replenishment;
  const e = d.excess;
  if (!r) return null;

  const proposed = r.lines.filter((l) => l.proposedQty > 0);

  return (
    <div className="space-y-6">
      <Narrative lines={r.warnings} tone="warn" />

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <PackagePlus className="h-4 w-4 text-emerald-600" />
          <h3 className="font-medium">Send to FBA</h3>
          <span className="text-sm text-muted-foreground">
            {r.totals.proposedUnits} units across {r.totals.skusProposed} SKUs · {money(r.totals.proposedCost)} at cost
          </span>
        </div>
        {/* Amazon's own number next to ours: the gap IS the Vine correction. */}
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          <span>Amazon recommends <strong className="text-foreground">{r.totals.amazonRecommendedUnits}</strong></span>
          <span>Paid-demand proposal <strong className="text-foreground">{r.totals.proposedUnits}</strong></span>
          {r.totals.shortfallUnits > 0 && (
            <span className="text-amber-700">Short {r.totals.shortfallUnits} units of warehouse stock</span>
          )}
          <span>Snapshot {r.snapshotDate ?? "—"} · {r.coverDays}-day cover</span>
        </div>

        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Product</th>
                <th className="px-2 py-2 text-right font-medium">Amazon<br />wants</th>
                <th className="px-2 py-2 text-right font-medium">Paid<br />30d</th>
                <th className="px-2 py-2 text-right font-medium">Free<br />30d</th>
                <th className="px-2 py-2 text-right font-medium">At<br />FBA</th>
                <th className="px-2 py-2 text-right font-medium">In<br />flight</th>
                <th className="px-2 py-2 text-right font-medium">Ware-<br />house</th>
                <th className="px-2 py-2 text-right font-medium">Send</th>
                <th className="px-2 py-2 text-right font-medium">Short</th>
                <th className="px-2 py-2 text-right font-medium">$/unit</th>
              </tr>
            </thead>
            <tbody>
              {proposed.slice(0, 40).map((l) => (
                <tr key={l.sku} className="border-t">
                  <td className="px-3 py-1.5">
                    <div className="font-medium">{l.title ?? l.sku}</div>
                    <div className="text-xs text-muted-foreground">{l.sku}</div>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{l.amazonRecommendedQty}</td>
                  <td className="px-2 py-1.5 text-right font-medium tabular-nums">{l.paidUnits30d}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{l.seededUnits30d || "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{l.fbaAvailable}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{l.inFlight || "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{l.warehouseAvailable}</td>
                  <td className="px-2 py-1.5 text-right font-medium tabular-nums">{l.proposedQty}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${l.shortfall > 0 ? "font-medium text-amber-700" : "text-muted-foreground"}`}>
                    {l.shortfall || "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {l.contributionPerUnit !== null ? `$${l.contributionPerUnit.toFixed(2)}` : "—"}
                  </td>
                </tr>
              ))}
              {proposed.length === 0 && (
                <tr><td colSpan={10} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  Nothing to send — no SKU is below its paid-demand cover target.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Generate the ShipHero transfer and FBA shipment plan with{" "}
          <code className="rounded bg-muted px-1">POST /api/admin/ops/amazon</code>{" "}
          <code className="rounded bg-muted px-1">{`{"action":"build-transfer"}`}</code>. Nothing is sent automatically.
        </p>
      </section>

      {e && e.lines.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <PackageMinus className="h-4 w-4 text-amber-600" />
            <h3 className="font-medium">Do not send / consider removing</h3>
            <span className="text-sm text-muted-foreground">
              {e.totals.excessUnits} units · {money(e.totals.excessValueAtCost)} tied up
              {e.totals.unfulfillableUnits > 0 && ` · ${e.totals.unfulfillableUnits} unsellable`}
            </span>
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Product</th>
                  <th className="px-2 py-2 text-right font-medium">At FBA</th>
                  <th className="px-2 py-2 text-right font-medium">Paid 30d</th>
                  <th className="px-2 py-2 text-right font-medium">Free 30d</th>
                  <th className="px-2 py-2 text-right font-medium">Cover</th>
                  <th className="px-2 py-2 text-right font-medium">Excess</th>
                  <th className="px-2 py-2 text-right font-medium">Value</th>
                  <th className="px-3 py-2 text-left font-medium">Why</th>
                </tr>
              </thead>
              <tbody>
                {e.lines.slice(0, 25).map((l) => (
                  <tr key={l.sku} className="border-t">
                    <td className="px-3 py-1.5">
                      <div className="font-medium">{l.title ?? l.sku}</div>
                      <div className="text-xs text-muted-foreground">{l.sku}</div>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{l.fbaAvailable}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{l.paidUnits30d}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{l.seededUnits30d || "—"}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                      {l.daysOfCover !== null ? `${l.daysOfCover}d` : "∞"}
                    </td>
                    <td className="px-2 py-1.5 text-right font-medium tabular-nums">{l.excessUnits}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{money(l.excessValueAtCost)}</td>
                    <td className="px-3 py-1.5">
                      <div className="flex flex-wrap gap-1">
                        {l.reasons.map((rs) => (
                          <span key={rs} className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            rs === "giveaway_propped" ? "bg-amber-100 text-amber-800"
                            : rs === "unfulfillable" ? "bg-red-100 text-red-800"
                            : "bg-muted text-muted-foreground"
                          }`}>
                            {rs.replace(/_/g, " ")}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Provenance lines={e.notes} />
        </section>
      )}
    </div>
  );
}

/** Small trend arrow used by the overview header. */
export function Trend({ value }: { value: number }) {
  const Icon = value >= 0 ? TrendingUp : TrendingDown;
  return <Icon className={`h-3.5 w-3.5 ${value >= 0 ? "text-emerald-600" : "text-red-600"}`} />;
}
