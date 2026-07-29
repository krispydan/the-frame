"use client";

/**
 * Product performance — the full best-sellers table.
 *
 * Every product at colorway grain with its wholesale/retail split, trend,
 * average order quantity, door count + repeat rate, margin, and stock cover.
 * Sortable, searchable, CSV-exportable. Three "so what" callouts surface the
 * decisions hiding in the table: heroes to lead with, risers about to stock
 * out, and dead weight tying up cash.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Delta } from "@/components/dashboard/delta";
import { money, num, pct } from "@/components/dashboard/format";
import { seriesColor, STATUS } from "@/components/dashboard/palette";
import { ArrowUpDown, Download, RefreshCw, Search, Trophy, AlertTriangle, Snowflake, X, Package, Truck } from "lucide-react";
import Link from "next/link";

type Row = {
  rootSku: string; productName: string; colorName: string; factoryCode: string | null;
  units: number; revenue: number;
  unitsWholesale: number; revenueWholesale: number;
  unitsRetail: number; revenueRetail: number; wholesaleSharePct: number;
  orderLines: number; avgOrderQty: number; accounts: number;
  repeatAccounts: number; repeatRatePct: number;
  unitsRecent: number; unitsPrior: number; trendPct: number | null; trend: string;
  unitCost: number | null; grossProfit: number | null; marginPct: number | null;
  onHand: number; available: number; weeklyRate: number; daysCover: number | null;
  onOrder: number; onOrderPos: OnOrderPo[]; totalPosition: number; daysCoverWithIncoming: number | null;
};
type OnOrderPo = {
  poId: string; poNumber: string; factory: string | null; status: string;
  units: number; expectedArrivalDate: string | null; expectedShipDate: string | null;
};
type Payload = {
  windowDays: number;
  totals: { units: number; revenue: number; unitsWholesale: number; unitsRetail: number; wholesaleSharePct: number; products: number; onHand: number; onOrder: number };
  rows: Row[];
};

type SortKey = "revenue" | "units" | "avgOrderQty" | "accounts" | "repeatRatePct" | "trendPct" | "marginPct" | "daysCover" | "wholesaleSharePct" | "onHand" | "onOrder" | "totalPosition";

const WHOLESALE_COLOR = seriesColor(0);
const RETAIL_COLOR = seriesColor(1);
const WINDOWS = [30, 60, 90, 180];

export default function ProductPerformancePage() {
  const [days, setDays] = useState(90);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("revenue");
  const [asc, setAsc] = useState(false);
  /** Row whose incoming-PO breakdown is open, if any. */
  const [poDetail, setPoDetail] = useState<Row | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/v1/inventory/product-performance?days=${days}&limit=500`)
      .then((r) => r.json())
      .then((d) => setData(d.error ? null : d))
      .finally(() => setLoading(false));
  }, [days]);

  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    if (!data) return [];
    const term = q.trim().toLowerCase();
    const filtered = term
      ? data.rows.filter((r) =>
          `${r.productName} ${r.colorName} ${r.rootSku}`.toLowerCase().includes(term))
      : data.rows;
    return [...filtered].sort((a, b) => {
      const av = (a[sort] ?? -Infinity) as number;
      const bv = (b[sort] ?? -Infinity) as number;
      return asc ? av - bv : bv - av;
    });
  }, [data, q, sort, asc]);

  // Decision callouts
  const heroes = useMemo(
    () => (data?.rows ?? []).filter((r) => r.accounts >= 3 && r.repeatRatePct >= 30).sort((a, b) => b.repeatRatePct - a.repeatRatePct).slice(0, 5),
    [data],
  );
  const atRisk = useMemo(
    // Thin cover is only a risk if nothing is inbound to fix it — judge on
    // cover-with-incoming so a product with a container landing isn't flagged.
    () => (data?.rows ?? []).filter((r) => (r.trendPct ?? 0) > 15 && r.daysCoverWithIncoming != null && r.daysCoverWithIncoming < 45).sort((a, b) => (a.daysCoverWithIncoming ?? 0) - (b.daysCoverWithIncoming ?? 0)).slice(0, 5),
    [data],
  );
  const deadWeight = useMemo(
    () => (data?.rows ?? []).filter((r) => r.totalPosition > 100 && r.weeklyRate < 3).sort((a, b) => b.totalPosition - a.totalPosition).slice(0, 5),
    [data],
  );

  const th = (key: SortKey, label: string, align: "left" | "right" = "right") => (
    <th className={`px-2 py-2 font-medium ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        className="inline-flex items-center gap-1 hover:text-foreground"
        onClick={() => { if (sort === key) setAsc((v) => !v); else { setSort(key); setAsc(false); } }}
      >
        {label} <ArrowUpDown className={`h-3 w-3 ${sort === key ? "text-foreground" : "text-muted-foreground/50"}`} />
      </button>
    </th>
  );

  return (
    <>
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Product performance</h1>
          <p className="text-sm text-muted-foreground">Best sellers by channel, trend, order depth and stock cover.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border p-0.5">
            {WINDOWS.map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${days === d ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {d}d
              </button>
            ))}
          </div>
          <Button variant="ghost" size="sm" onClick={load}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /></Button>
          <Button
            variant="outline"
            size="sm"
            render={<a href={`/api/v1/inventory/product-performance?days=${days}&limit=1000&format=csv`} />}
          >
            <Download className="mr-1 h-4 w-4" /> CSV
          </Button>
        </div>
      </div>

      {/* Summary */}
      {data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label="Units sold" value={num(data.totals.units)} />
          <Tile label="Revenue" value={money(data.totals.revenue, { compact: data.totals.revenue >= 100000 })} />
          <Tile label="Wholesale share" value={pct(data.totals.wholesaleSharePct)} sub={`${num(data.totals.unitsRetail)} units retail`} />
          <Tile label="Products sold" value={num(data.totals.products)} />
          <Tile label="On hand" value={num(data.totals.onHand)} sub="units in the warehouse" />
          <Tile label="On order" value={num(data.totals.onOrder)} sub="units on open POs" />
        </div>
      )}

      {/* Callouts */}
      <div className="grid gap-4 md:grid-cols-3">
        <Callout title="Hero products" hint="Repeat-ordered by multiple doors — lead with these" icon={<Trophy className="h-4 w-4" />} tone={STATUS.good}
          rows={heroes.map((r) => ({ key: r.rootSku, main: `${r.productName} · ${r.colorName}`, meta: `${pct(r.repeatRatePct)} reorder · ${num(r.accounts)} doors` }))} />
        <Callout title="Rising, thin cover" hint="Demand climbing but stock runs out soon" icon={<AlertTriangle className="h-4 w-4" />} tone={STATUS.serious}
          rows={atRisk.map((r) => ({ key: r.rootSku, main: `${r.productName} · ${r.colorName}`, meta: `${r.daysCover}d cover · ${r.trendPct != null ? `+${r.trendPct.toFixed(0)}%` : ""}` }))} />
        <Callout title="Dead weight" hint="Deep stock, slow movement — cash tied up" icon={<Snowflake className="h-4 w-4" />} tone={STATUS.neutral}
          rows={deadWeight.map((r) => ({ key: r.rootSku, main: `${r.productName} · ${r.colorName}`, meta: `${num(r.onHand)} on hand${r.onOrder > 0 ? ` + ${num(r.onOrder)} inbound` : ""} · ${r.weeklyRate.toFixed(1)}/wk` }))} />
      </div>

      {/* Table */}
      <div className="rounded-xl border">
        <div className="flex items-center gap-2 border-b p-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search style, color or SKU…" className="h-8 max-w-xs" />
          <span className="ml-auto text-xs text-muted-foreground">{rows.length} products</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Product</th>
                <th className="px-2 py-2 text-left font-medium">Channel split</th>
                {th("units", "Units")}
                {th("revenue", "Revenue")}
                {th("avgOrderQty", "Avg qty")}
                {th("accounts", "Doors")}
                {th("repeatRatePct", "Reorder")}
                {th("trendPct", "Trend")}
                {th("marginPct", "Margin")}
                {th("onHand", "On hand")}
                {th("onOrder", "On order")}
                {th("daysCover", "Cover")}
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}><td colSpan={12} className="px-3 py-3"><div className="h-4 animate-pulse rounded bg-muted" /></td></tr>
                ))
              ) : rows.length === 0 ? (
                <tr><td colSpan={12} className="px-3 py-10 text-center text-muted-foreground">No products sold in this window</td></tr>
              ) : (
                rows.map((r) => {
                  const wShare = r.wholesaleSharePct;
                  return (
                    <tr key={r.rootSku} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-3 py-2">
                        <div className="font-medium">{r.productName}</div>
                        <div className="text-xs text-muted-foreground">{r.colorName} · {r.rootSku}</div>
                      </td>
                      <td className="px-2 py-2 w-40">
                        <div className="flex h-2 w-full gap-[2px] overflow-hidden rounded-full bg-muted">
                          {r.unitsWholesale > 0 && <div className="h-full rounded-full" style={{ width: `${Math.max(2, wShare)}%`, backgroundColor: WHOLESALE_COLOR }} />}
                          {r.unitsRetail > 0 && <div className="h-full rounded-full" style={{ width: `${Math.max(2, 100 - wShare)}%`, backgroundColor: RETAIL_COLOR }} />}
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                          {num(r.unitsWholesale)} W · {num(r.unitsRetail)} R
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{num(r.units)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{money(r.revenue, { compact: r.revenue >= 10000 })}</td>
                      <td className="px-2 py-2 text-right tabular-nums font-medium">{r.avgOrderQty.toFixed(1)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{num(r.accounts)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{r.accounts > 0 ? pct(r.repeatRatePct) : "—"}</td>
                      <td className="px-2 py-2 text-right">
                        {r.trend === "new" ? <Badge variant="secondary" className="text-[10px]">new</Badge> : <Delta value={r.trendPct} />}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{r.marginPct != null ? pct(r.marginPct) : "—"}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        <span style={r.onHand === 0 ? { color: STATUS.serious, fontWeight: 500 } : undefined}>{num(r.onHand)}</span>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {r.onOrder > 0 ? (
                          <button
                            onClick={() => setPoDetail(r)}
                            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                            title={`${r.onOrderPos.length} open PO${r.onOrderPos.length === 1 ? "" : "s"} — click for detail`}
                          >
                            {num(r.onOrder)}
                            <Truck className="h-3 w-3" />
                          </button>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {r.daysCover == null ? "—" : (
                          <span style={r.daysCover < 30 ? { color: STATUS.serious, fontWeight: 500 } : undefined}>{r.daysCover}d</span>
                        )}
                        {/* Cover including inbound stock — the number that says
                            whether thin cover is actually a problem. */}
                        {r.onOrder > 0 && r.daysCoverWithIncoming != null && r.daysCoverWithIncoming !== r.daysCover && (
                          <div className="text-[11px] text-muted-foreground">{r.daysCoverWithIncoming}d w/ inbound</div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Wholesale = Faire, Shopify Wholesale, direct &amp; phone orders. Retail = Shopify DTC. Units are pack-expanded
        (a 12-pack counts as 12) and rolled up to the colorway, so they match the demand forecast. Margin uses catalog cost price.
        On order counts units on POs that haven&apos;t been received yet — click a figure to see which POs and when they land.
      </p>
    </div>
    {poDetail && <IncomingPoDrawer row={poDetail} onClose={() => setPoDetail(null)} />}
    </>
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

/** Status labels that read like a shipment, not a DB enum. */
const PO_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  confirmed: "Confirmed",
  in_production: "In production",
  shipped: "Shipped",
  in_transit: "In transit",
  received: "Received",
  complete: "Complete",
};

/**
 * The units-on-order breakdown for one product.
 *
 * Clicking a bare "on order" total answers the wrong question — a planner needs
 * to know *when* it lands and *which* PO to chase, so each row links straight
 * through to the purchase order.
 */
function IncomingPoDrawer({ row, onClose }: { row: Row; onClose: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-end bg-black/30"
      onClick={onClose}
      role="presentation"
    >
      <aside
        className="h-full w-full max-w-md overflow-y-auto border-l bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start gap-3 border-b px-4 py-3">
          <span className="mt-0.5 rounded-md bg-muted p-1.5"><Truck className="h-4 w-4" /></span>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold">{row.productName}</h3>
            <p className="truncate text-xs text-muted-foreground">{row.colorName} · {row.rootSku}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button>
        </header>

        <div className="grid grid-cols-3 gap-2 border-b px-4 py-3 text-center">
          <div>
            <div className="text-lg font-semibold tabular-nums">{num(row.onHand)}</div>
            <div className="text-[11px] text-muted-foreground">On hand</div>
          </div>
          <div>
            <div className="text-lg font-semibold tabular-nums">{num(row.onOrder)}</div>
            <div className="text-[11px] text-muted-foreground">On order</div>
          </div>
          <div>
            <div className="text-lg font-semibold tabular-nums">{num(row.totalPosition)}</div>
            <div className="text-[11px] text-muted-foreground">Total position</div>
          </div>
        </div>

        <div className="border-b px-4 py-2.5 text-xs text-muted-foreground">
          Selling {row.weeklyRate.toFixed(1)}/wk ·{" "}
          {row.daysCover == null ? "no cover estimate" : `${row.daysCover}d cover`}
          {row.onOrder > 0 && row.daysCoverWithIncoming != null && (
            <> · <span className="text-foreground">{row.daysCoverWithIncoming}d including inbound</span></>
          )}
        </div>

        <ul className="divide-y">
          {row.onOrderPos.map((po) => {
            // A promised arrival that's already in the past is the single most
            // useful thing to surface here — it means the PO needs chasing.
            const late = !!po.expectedArrivalDate && po.expectedArrivalDate < today;
            return (
              <li key={po.poId} className="px-4 py-3">
                <div className="flex items-baseline justify-between gap-2">
                  <Link href={`/inventory/purchase-orders?po=${encodeURIComponent(po.poNumber)}`} className="font-medium text-primary hover:underline">
                    {po.poNumber}
                  </Link>
                  <span className="shrink-0 tabular-nums font-semibold">{num(po.units)} units</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  {po.factory && <span>{po.factory}</span>}
                  <Badge variant="secondary" className="text-[10px]">{PO_STATUS_LABEL[po.status] ?? po.status}</Badge>
                </div>
                <div className="mt-1 text-xs">
                  {po.expectedArrivalDate ? (
                    <span style={late ? { color: STATUS.serious, fontWeight: 500 } : undefined}>
                      {late ? "Overdue — expected" : "Arrives"} {po.expectedArrivalDate}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">No arrival date on the PO</span>
                  )}
                  {po.expectedShipDate && (
                    <span className="text-muted-foreground"> · ships {po.expectedShipDate}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        <div className="px-4 py-3">
          <Button variant="outline" size="sm" render={<Link href="/inventory/purchase-orders" />}>
            <Package className="mr-1.5 h-3.5 w-3.5" /> All purchase orders
          </Button>
        </div>
      </aside>
    </div>
  );
}
