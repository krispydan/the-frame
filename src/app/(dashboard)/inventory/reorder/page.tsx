"use client";

/**
 * Reorder plan — the demand forecast made actionable.
 *
 * Groups what to buy by factory (that's how POs get placed), net of in-flight
 * POs, with safety stock and MOQ already applied. Slow/dead sellers are held
 * back by default and shown separately so the buy is deliberate, not automatic.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { num } from "@/components/dashboard/format";
import { STATUS } from "@/components/dashboard/palette";
import { Download, RefreshCw, Ship, AlertTriangle, ChevronDown } from "lucide-react";

type Row = {
  sku: string; productName: string; colorName: string;
  factoryCode: string; factoryName: string;
  currentStock: number; reservedStock: number; availableStock: number;
  incomingUnits: number; incomingArrival: string | null;
  projectedWeeklyRate: number; velocity: string; trendDirection: string;
  effectiveDaysOfCover: number; projectedStockoutDate: string | null;
  safetyStock: number; recommendedReorderQty: number; urgencyLevel: string;
  notes: string;
};
type Payload = {
  targetDays: number;
  seasonality: string;
  summary: {
    reorderSkus: number; reorderUnits: number; critical: number; urgent: number; watch: number;
    withIncomingPo: number; incomingUnits: number; excludedSlowSellers: number; totalRoots: number;
  };
  byFactory: Array<{ factory: string; code: string; units: number; skus: number; rows: Row[] }>;
  excluded: Array<{ sku: string; style: string; color: string; factory: string; velocity: string; weeklyRate: number; available: number; wouldHaveOrdered: number }>;
};

const URGENCY_TONE: Record<string, string> = {
  critical: STATUS.critical,
  urgent: STATUS.serious,
  watch: STATUS.warn,
  ok: STATUS.neutral,
};
const TARGETS = [60, 90, 120];

export default function ReorderPage() {
  const [targetDays, setTargetDays] = useState(90);
  const [includeSlow, setIncludeSlow] = useState(false);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  // Track which factories the user COLLAPSED, so every factory is open by
  // default without having to set state after the fetch resolves.
  const [closedFactories, setClosedFactories] = useState<string[]>([]);
  const [showExcluded, setShowExcluded] = useState(false);

  const [nonce, setNonce] = useState(0);

  // Stale-while-revalidate: the effect never setStates synchronously (it only
  // resolves state in the async continuation), so changing the range keeps the
  // current table on screen until fresh numbers land instead of flashing a
  // skeleton. The refresh button drives `nonce`.
  useEffect(() => {
    let cancelled = false;
    const qs = `targetDays=${targetDays}${includeSlow ? "&include=slow,dead" : ""}`;
    (async () => {
      try {
        const res = await fetch(`/api/v1/inventory/reorder?${qs}`);
        const d = await res.json();
        if (!cancelled) setData(d.error ? null : d);
      } catch {
        /* keep whatever we had */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [targetDays, includeSlow, nonce]);

  const load = useCallback(() => setNonce((n) => n + 1), []);

  const toggle = (f: string) =>
    setClosedFactories((prev) => (prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]));

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reorder plan</h1>
          <p className="text-sm text-muted-foreground">
            What to buy, by factory — net of in-flight POs, with safety stock and MOQ applied.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">Cover</div>
          <div className="flex rounded-lg border p-0.5">
            {TARGETS.map((d) => (
              <button
                key={d}
                onClick={() => setTargetDays(d)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${targetDays === d ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {d}d
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={includeSlow} onChange={(e) => setIncludeSlow(e.target.checked)} />
            Include slow sellers
          </label>
          <Button variant="ghost" size="sm" onClick={load}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /></Button>
          <Button
            variant="outline"
            size="sm"
            render={<a href={`/api/v1/inventory/reorder?targetDays=${targetDays}${includeSlow ? "&include=slow,dead" : ""}&format=csv`} />}
          >
            <Download className="mr-1 h-4 w-4" /> CSV
          </Button>
        </div>
      </div>

      {data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="To reorder" value={num(data.summary.reorderUnits)} sub={`${num(data.summary.reorderSkus)} SKUs`} />
          <Tile label="Critical" value={num(data.summary.critical)} tone={data.summary.critical > 0 ? STATUS.critical : undefined} sub={`${num(data.summary.urgent)} urgent · ${num(data.summary.watch)} watch`} />
          <Tile label="On the water" value={num(data.summary.incomingUnits)} sub={`${num(data.summary.withIncomingPo)} SKUs with open POs`} />
          <Tile label="Held back" value={num(data.summary.excludedSlowSellers)} sub="slow / dead sellers" />
        </div>
      )}

      {loading && !data ? (
        <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-32 animate-pulse rounded-xl border bg-muted/40" />)}</div>
      ) : !data || data.byFactory.length === 0 ? (
        <div className="rounded-xl border p-10 text-center text-muted-foreground">
          ✅ Nothing needs reordering at {targetDays} days of cover.
        </div>
      ) : (
        data.byFactory.map((f) => {
          const open = !closedFactories.includes(f.factory);
          return (
            <section key={f.factory} className="rounded-xl border">
              <button onClick={() => toggle(f.factory)} className="flex w-full items-center gap-2 border-b px-4 py-3 text-left">
                <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-sm font-semibold">{f.factory}</h2>
                  <p className="text-xs text-muted-foreground">{f.code} · {num(f.skus)} SKUs</p>
                </div>
                <span className="shrink-0 text-right">
                  <span className="block text-lg font-semibold tabular-nums">{num(f.units)}</span>
                  <span className="text-xs text-muted-foreground">units</span>
                </span>
              </button>
              {open && (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[820px] text-sm">
                    <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Product</th>
                        <th className="px-2 py-2 text-right font-medium">Rate</th>
                        <th className="px-2 py-2 text-right font-medium">Available</th>
                        <th className="px-2 py-2 text-right font-medium">Incoming</th>
                        <th className="px-2 py-2 text-right font-medium">Cover</th>
                        <th className="px-2 py-2 text-right font-medium">Safety</th>
                        <th className="px-2 py-2 text-right font-medium">Order</th>
                        <th className="px-2 py-2 text-left font-medium">Urgency</th>
                      </tr>
                    </thead>
                    <tbody>
                      {f.rows.map((r) => (
                        <tr key={r.sku} className="border-b last:border-0 hover:bg-muted/30">
                          <td className="px-3 py-2">
                            <div className="font-medium">{r.productName}</div>
                            <div className="text-xs text-muted-foreground">{r.colorName} · {r.sku}</div>
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">{r.projectedWeeklyRate}/wk</td>
                          <td className="px-2 py-2 text-right tabular-nums">{num(r.availableStock)}</td>
                          <td className="px-2 py-2 text-right tabular-nums">
                            {r.incomingUnits > 0 ? (
                              <span className="inline-flex items-center gap-1 text-muted-foreground">
                                <Ship className="h-3 w-3" />{num(r.incomingUnits)}
                                {r.incomingArrival && <span className="text-[11px]">{r.incomingArrival.slice(5)}</span>}
                              </span>
                            ) : "—"}
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">
                            <span style={r.effectiveDaysOfCover < 30 ? { color: STATUS.serious, fontWeight: 500 } : undefined}>
                              {r.effectiveDaysOfCover >= 9999 ? "—" : `${r.effectiveDaysOfCover}d`}
                            </span>
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{num(r.safetyStock)}</td>
                          <td className="px-2 py-2 text-right text-base font-semibold tabular-nums">{num(r.recommendedReorderQty)}</td>
                          <td className="px-2 py-2">
                            <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize"
                              style={{ backgroundColor: `${URGENCY_TONE[r.urgencyLevel]}1a`, color: URGENCY_TONE[r.urgencyLevel] }}>
                              {r.urgencyLevel === "critical" && <AlertTriangle className="h-3 w-3" />}
                              {r.urgencyLevel}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })
      )}

      {data && data.excluded.length > 0 && (
        <section className="rounded-xl border">
          <button onClick={() => setShowExcluded((v) => !v)} className="flex w-full items-center gap-2 px-4 py-3 text-left">
            <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${showExcluded ? "" : "-rotate-90"}`} />
            <div>
              <h2 className="text-sm font-semibold">Held back — slow &amp; dead sellers ({data.excluded.length})</h2>
              <p className="text-xs text-muted-foreground">These would qualify on stock alone, but they aren&apos;t selling fast enough to justify a buy.</p>
            </div>
          </button>
          {showExcluded && (
            <ul className="divide-y border-t">
              {data.excluded.map((r) => (
                <li key={r.sku} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                  <div className="min-w-0">
                    <span className="font-medium">{r.style}</span>
                    <span className="text-muted-foreground"> · {r.color} · {r.sku}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                    <Badge variant="outline" className="capitalize">{r.velocity}</Badge>
                    <span>{r.weeklyRate}/wk</span>
                    <span>{num(r.available)} on hand</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {data && (
        <p className="text-xs text-muted-foreground">
          Quantities cover lead time plus {data.targetDays} days of demand, minus stock on hand and units already on the water,
          rounded up to inner-pack multiples and each factory&apos;s MOQ. Seasonality: {data.seasonality === "learned" ? "learned from order history" : "default curve (not enough history yet)"}.
        </p>
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
