"use client";

/**
 * Factory lead times.
 *
 * These are the highest-leverage numbers in the whole inventory system and they
 * had no home: the reorder forecaster covers production + transit + target
 * stock days, so a lead time that's wrong by six weeks is a buy that's wrong by
 * six weeks of demand. Brilliant sat at the 32-day import default against an
 * actual 75 and nothing on screen said so.
 *
 * Editable inline, with the resulting coverage window and a worked "order today
 * → lands on" date shown next to each factory, so the consequence of the number
 * is visible at the moment you type it.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { num } from "@/components/dashboard/format";
import { STATUS } from "@/components/dashboard/palette";
import { Factory, RefreshCw, Save, Plane, Ship, CalendarClock, Info } from "lucide-react";

type Row = {
  id: string; code: string; name: string;
  productionLeadDays: number; transitLeadDays: number; airTransitLeadDays: number | null;
  totalLeadDays: number; totalLeadDaysAir: number | null;
  moq: number | null; notes: string | null;
  openPos: number; openUnits: number; nextArrival: string | null;
  skus: number;
};

/** Target stock days the reorder plan defaults to — shown so the coverage
 *  window on this page matches what the forecaster actually uses. */
const TARGET_STOCK_DAYS = 90;

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export default function FactoriesPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState<Record<string, Partial<Row>>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/v1/inventory/factories")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { setError(d.error); return; }
        setRows(d.factories ?? []);
        setCanEdit(!!d.canEdit);
        setEdits({});
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  function edit(code: string, field: keyof Row, value: string) {
    const n = value === "" ? null : parseInt(value, 10);
    setEdits((prev) => ({ ...prev, [code]: { ...prev[code], [field]: n as never } }));
  }

  function valueOf(r: Row, field: "productionLeadDays" | "transitLeadDays" | "airTransitLeadDays" | "moq"): number | null {
    const e = edits[r.code];
    if (e && field in e) return (e[field] ?? null) as number | null;
    return r[field];
  }

  const dirty = (code: string) => !!edits[code] && Object.keys(edits[code]).length > 0;

  async function save(r: Row) {
    setSaving(r.code);
    setError(null);
    try {
      const res = await fetch("/api/v1/inventory/factories", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: r.code,
          productionLeadDays: valueOf(r, "productionLeadDays"),
          transitLeadDays: valueOf(r, "transitLeadDays"),
          airTransitLeadDays: valueOf(r, "airTransitLeadDays"),
          moq: valueOf(r, "moq"),
        }),
      });
      const d = await res.json();
      if (!d.ok) setError(d.error || "Save failed");
      else load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Factories &amp; lead times</h1>
          <p className="text-sm text-muted-foreground">
            Production and shipping timeframes per factory. These drive every reorder recommendation.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button variant="ghost" size="sm" render={<Link href="/inventory/reorder" />}>Reorder plan</Button>
          <Button variant="ghost" size="sm" render={<Link href="/inventory/purchase-orders" />}>Purchase orders</Button>
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>
          The reorder forecaster buys enough to cover <strong>production + ocean transit + {TARGET_STOCK_DAYS} days
          of target stock</strong>. Ocean transit is what a normal replenishment plans against; air is only used to
          date the arrival of a PO that actually ships air. If a factory quotes you one all-in number, split it —
          put the making time in production and the sailing time in ocean.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border p-3 text-sm" style={{ backgroundColor: `${STATUS.critical}0f`, borderColor: `${STATUS.critical}55` }}>
          {error}
        </div>
      )}

      <div className="rounded-xl border bg-card">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Factory className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Factories</span>
          {!canEdit && <Badge variant="secondary" className="ml-auto text-[10px]">read only for your role</Badge>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Factory</th>
                <th className="px-2 py-2 text-right font-medium">Production</th>
                <th className="px-2 py-2 text-right font-medium">
                  <span className="inline-flex items-center gap-1"><Ship className="h-3 w-3" /> Ocean</span>
                </th>
                <th className="px-2 py-2 text-right font-medium">
                  <span className="inline-flex items-center gap-1"><Plane className="h-3 w-3" /> Air</span>
                </th>
                <th className="px-2 py-2 text-right font-medium">Total lead</th>
                <th className="px-2 py-2 text-right font-medium">Order today → lands</th>
                <th className="px-2 py-2 text-right font-medium">Reorder covers</th>
                <th className="px-2 py-2 text-right font-medium">MOQ</th>
                <th className="px-2 py-2 text-right font-medium">Open POs</th>
                {canEdit && <th className="px-2 py-2" />}
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}><td colSpan={10} className="px-3 py-3"><div className="h-4 animate-pulse rounded bg-muted" /></td></tr>
                ))
              ) : rows.length === 0 ? (
                <tr><td colSpan={10} className="px-3 py-10 text-center text-muted-foreground">No factories yet</td></tr>
              ) : (
                rows.map((r) => {
                  const prod = valueOf(r, "productionLeadDays") ?? 0;
                  const ocean = valueOf(r, "transitLeadDays") ?? 0;
                  const air = valueOf(r, "airTransitLeadDays");
                  const total = prod + ocean;
                  const coverage = total + TARGET_STOCK_DAYS;
                  return (
                    <tr key={r.code} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-3 py-2">
                        <div className="font-medium">{r.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.code} · {num(r.skus)} SKUs
                        </div>
                      </td>
                      <NumCell value={prod} canEdit={canEdit} onChange={(v) => edit(r.code, "productionLeadDays", v)} suffix="d" />
                      <NumCell value={ocean} canEdit={canEdit} onChange={(v) => edit(r.code, "transitLeadDays", v)} suffix="d" />
                      <NumCell value={air} canEdit={canEdit} onChange={(v) => edit(r.code, "airTransitLeadDays", v)} suffix="d" />
                      <td className="px-2 py-2 text-right tabular-nums font-semibold">
                        {total}d
                        {air != null && (
                          <div className="text-[11px] font-normal text-muted-foreground">{prod + air}d air</div>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-xs text-muted-foreground">
                        {addDays(total)}
                        {air != null && <div className="text-[11px]">{addDays(prod + air)} air</div>}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        <span className="inline-flex items-center gap-1">
                          <CalendarClock className="h-3 w-3 text-muted-foreground" />
                          {coverage}d
                        </span>
                      </td>
                      <NumCell value={valueOf(r, "moq")} canEdit={canEdit} onChange={(v) => edit(r.code, "moq", v)} />
                      <td className="px-2 py-2 text-right tabular-nums">
                        {r.openPos > 0 ? (
                          <Link href="/inventory/purchase-orders" className="text-primary hover:underline">
                            {r.openPos}
                          </Link>
                        ) : (
                          <span style={{ color: STATUS.serious }}>0</span>
                        )}
                        {r.openUnits > 0 && (
                          <div className="text-[11px] text-muted-foreground">{num(r.openUnits)}u · {r.nextArrival ?? "no date"}</div>
                        )}
                      </td>
                      {canEdit && (
                        <td className="px-2 py-2 text-right">
                          <Button
                            size="sm"
                            variant={dirty(r.code) ? "default" : "ghost"}
                            disabled={!dirty(r.code) || saving === r.code}
                            onClick={() => save(r)}
                          >
                            <Save className="mr-1 h-3 w-3" />
                            {saving === r.code ? "Saving…" : "Save"}
                          </Button>
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        <strong>Production</strong> is the factory&apos;s making time from PO to goods ready.
        <strong> Ocean</strong> and <strong>air</strong> are door-to-door transit from ready to received.
        <strong> Total lead</strong> is production + ocean — the realistic wait on a normal replenishment.
        <strong> Reorder covers</strong> is what the forecaster buys against: total lead + {TARGET_STOCK_DAYS} days of
        stock, because you can&apos;t reorder again inside the lead time. A factory with no open POs is flagged, since
        nothing is inbound from them at all.
      </p>
    </div>
  );
}

function NumCell({
  value, canEdit, onChange, suffix,
}: {
  value: number | null; canEdit: boolean; onChange: (v: string) => void; suffix?: string;
}) {
  if (!canEdit) {
    return (
      <td className="px-2 py-2 text-right tabular-nums">
        {value == null ? "—" : `${value}${suffix ?? ""}`}
      </td>
    );
  }
  return (
    <td className="px-2 py-2 text-right">
      <Input
        type="number"
        min={1}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-20 text-right tabular-nums"
      />
    </td>
  );
}
