"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  ArrowLeft, Users, DollarSign, TrendingUp, AlertTriangle, MapPin, Loader2, Star, Clock,
} from "lucide-react";
import Link from "next/link";
import type { GeoPoint } from "@/modules/customers/components/customer-map";

// Leaflet touches window → client-only
const CustomerMap = dynamic(() => import("@/modules/customers/components/customer-map"), {
  ssr: false,
  loading: () => <div className="h-[480px] flex items-center justify-center bg-muted/40 rounded-lg text-muted-foreground">Loading map…</div>,
});
const StateChoropleth = dynamic(() => import("@/modules/customers/components/state-choropleth"), {
  ssr: false,
  loading: () => <div className="h-[420px] flex items-center justify-center bg-muted/40 rounded-lg text-muted-foreground">Loading map…</div>,
});

interface Analytics {
  kpi: { customerCount: number; totalLtv: number; avgLtv: number; totalOrders: number; atRiskCount: number; churnedCount: number; newThisMonth: number };
  bestCustomers: Array<{ companyId: string; name: string; segment: string | null; state: string | null; tier: string; ltv: number; orders: number; aov: number; health: string; lastOrderAt: string | null }>;
  atRisk: Array<{ companyId: string; name: string; segment: string | null; state: string | null; tier: string; ltv: number; orders: number; health: string; lastOrderAt: string | null; nextReorder: string | null; daysSinceLastOrder: number | null }>;
  byState: Array<{ state: string; customers: number; revenue: number }>;
  geoPoints: GeoPoint[];
  byHealth: Array<{ status: string; count: number; revenue: number }>;
  byTier: Array<{ tier: string; count: number; revenue: number }>;
  geocode: { mapped: number; pending: number; total: number };
}

function money(n: number, dp = 0) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: dp }).format(n);
}
function fmtDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const HEALTH_BADGE: Record<string, string> = {
  healthy: "bg-green-100 text-green-700",
  at_risk: "bg-amber-100 text-amber-700",
  churning: "bg-red-100 text-red-700",
  churned: "bg-gray-200 text-gray-600",
};
const TIER_BADGE: Record<string, string> = {
  platinum: "bg-indigo-100 text-indigo-700",
  gold: "bg-yellow-100 text-yellow-700",
  silver: "bg-gray-100 text-gray-600",
  bronze: "bg-orange-100 text-orange-700",
};

export default function CustomerAnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [geocoding, setGeocoding] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/customers/analytics");
      if (res.ok) setData(await res.json());
    } catch {
      toast.error("Failed to load customer analytics");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Geocode in small batches until none remain, refreshing the map as we go.
  // retryFailed=true re-attempts companies that were tried before but still
  // have no coordinates (transient Nominatim failures / improved fallback).
  const runGeocode = useCallback(async (retryFailed = false) => {
    setGeocoding(true);
    try {
      let rounds = 0;
      const maxRounds = 60;
      while (rounds < maxRounds) {
        const res = await fetch("/api/v1/customers/geocode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit: 15, retryFailed }),
        });
        const d = await res.json();
        rounds++;
        toast.message(`Geocoded ${d.geocoded ?? 0} this batch · ${d.remaining ?? 0} pending`);
        await load();
        // Stop when a batch processes nothing (queue drained for this mode).
        if ((d.processed ?? 0) === 0) break;
      }
      toast.success("Geocoding complete");
    } catch {
      toast.error("Geocoding failed");
    } finally {
      setGeocoding(false);
    }
  }, [load]);

  if (loading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }
  if (!data) return <div className="p-6 text-muted-foreground">No data.</div>;

  const { kpi, geocode } = data;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/customers" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Customer Analytics</h1>
          <p className="text-muted-foreground">Where your customers are, who your best are, and who&apos;s slipping away</p>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <Card><CardContent className="pt-6">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Users className="h-3.5 w-3.5" /> Customers</p>
          <p className="text-2xl font-bold">{kpi.customerCount.toLocaleString()}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-6">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><DollarSign className="h-3.5 w-3.5" /> Total LTV</p>
          <p className="text-2xl font-bold">{money(kpi.totalLtv)}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-6">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><TrendingUp className="h-3.5 w-3.5" /> Avg LTV</p>
          <p className="text-2xl font-bold">{money(kpi.avgLtv)}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-6">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Star className="h-3.5 w-3.5" /> New this month</p>
          <p className="text-2xl font-bold">{kpi.newThisMonth.toLocaleString()}</p>
        </CardContent></Card>
        <Card className="border-amber-200"><CardContent className="pt-6">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> At risk</p>
          <p className="text-2xl font-bold text-amber-600">{kpi.atRiskCount.toLocaleString()}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-6">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> Churned</p>
          <p className="text-2xl font-bold">{kpi.churnedCount.toLocaleString()}</p>
        </CardContent></Card>
      </div>

      {/* Map */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <MapPin className="h-4 w-4" /> Customer Map
            <span className="text-xs font-normal text-muted-foreground">
              {geocode.mapped} of {geocode.total} mapped
              {geocode.pending > 0 ? ` · ${geocode.pending} pending` : ""}
              {(() => {
                const failed = Math.max(0, geocode.total - geocode.mapped - geocode.pending);
                return failed > 0 ? ` · ${failed} couldn't be located` : "";
              })()}
            </span>
          </CardTitle>
          <div className="flex items-center gap-2">
            {geocode.pending > 0 && (
              <Button size="sm" variant="outline" onClick={() => runGeocode(false)} disabled={geocoding}>
                {geocoding ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <MapPin className="h-4 w-4 mr-1" />}
                {geocoding ? "Geocoding…" : `Geocode ${geocode.pending}`}
              </Button>
            )}
            {geocode.pending === 0 && (geocode.total - geocode.mapped) > 0 && (
              <Button size="sm" variant="outline" onClick={() => runGeocode(true)} disabled={geocoding}>
                {geocoding ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <MapPin className="h-4 w-4 mr-1" />}
                {geocoding ? "Retrying…" : `Retry ${geocode.total - geocode.mapped} failed`}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {data.geoPoints.length === 0 ? (
            <div className="h-[300px] flex flex-col items-center justify-center bg-muted/40 rounded-lg gap-3 text-center">
              <MapPin className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground max-w-sm">
                No customers geocoded yet. Click &quot;Geocode customers&quot; above to place them on the map
                (addresses are looked up one per second, so this runs in the background).
              </p>
            </div>
          ) : (
            <>
              <CustomerMap points={data.geoPoints} />
              <div className="flex flex-wrap items-center gap-4 mt-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full bg-green-600" /> Healthy</span>
                <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full bg-amber-600" /> At risk</span>
                <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full bg-red-600" /> Churning</span>
                <span className="ml-2">Circle size = lifetime value</span>
                <span className="ml-auto italic">Zoom in to see individual stores; zoom out for the heatmap</span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Best customers */}
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Star className="h-4 w-4" /> Best Customers</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow>
                <TableHead>Customer</TableHead><TableHead>Tier</TableHead>
                <TableHead className="text-right">LTV</TableHead><TableHead className="text-right">Orders</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {data.bestCustomers.map((c) => (
                  <TableRow key={c.companyId}>
                    <TableCell>
                      <Link href={`/customers`} className="font-medium hover:underline">{c.name}</Link>
                      <div className="text-xs text-muted-foreground">{[c.segment, c.state].filter(Boolean).join(" · ")}</div>
                    </TableCell>
                    <TableCell><span className={`px-1.5 py-0.5 rounded text-xs font-medium ${TIER_BADGE[c.tier] || "bg-gray-100"}`}>{c.tier}</span></TableCell>
                    <TableCell className="text-right font-semibold">{money(c.ltv)}</TableCell>
                    <TableCell className="text-right">{c.orders}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* At-risk */}
        <Card className="border-amber-200">
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-600" /> At Risk — chase these</CardTitle></CardHeader>
          <CardContent>
            {data.atRisk.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No at-risk customers. 🎉</p>
            ) : (
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Customer</TableHead><TableHead className="text-right">LTV</TableHead>
                  <TableHead className="text-right">Last order</TableHead><TableHead>Health</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {data.atRisk.map((c) => (
                    <TableRow key={c.companyId}>
                      <TableCell>
                        <span className="font-medium">{c.name}</span>
                        <div className="text-xs text-muted-foreground">{[c.segment, c.state].filter(Boolean).join(" · ")}</div>
                      </TableCell>
                      <TableCell className="text-right font-semibold">{money(c.ltv)}</TableCell>
                      <TableCell className="text-right text-sm">
                        {fmtDate(c.lastOrderAt)}
                        {c.daysSinceLastOrder != null && <div className="text-xs text-amber-600">{c.daysSinceLastOrder}d ago</div>}
                      </TableCell>
                      <TableCell><span className={`px-1.5 py-0.5 rounded text-xs font-medium ${HEALTH_BADGE[c.health] || "bg-gray-100"}`}>{c.health.replace("_", " ")}</span></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* By state — choropleth + ranked list */}
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><MapPin className="h-4 w-4" /> Revenue by State</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2">
              <StateChoropleth data={data.byState.filter((s) => s.state && s.state !== "—")} />
            </div>
            {/* Ranked list beside the map */}
            <div className="space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
              {(() => {
                const rows = data.byState.filter((s) => s.state && s.state !== "—");
                const max = Math.max(1, ...rows.map((r) => r.revenue));
                return rows.map((s) => (
                  <div key={s.state} className="relative rounded-md border px-2.5 py-1.5 overflow-hidden">
                    <div
                      className="absolute inset-y-0 left-0 bg-green-100/70"
                      style={{ width: `${Math.max(4, (s.revenue / max) * 100)}%` }}
                    />
                    <div className="relative flex items-center justify-between text-sm">
                      <span className="font-semibold">{s.state}</span>
                      <span className="tabular-nums">{money(s.revenue)}</span>
                    </div>
                    <div className="relative text-xs text-muted-foreground">{s.customers} customer{s.customers === 1 ? "" : "s"}</div>
                  </div>
                ));
              })()}
              {data.byState.some((s) => !s.state || s.state === "—") && (
                <p className="text-xs text-muted-foreground pt-1">
                  International / no-state customers appear on the pin map above.
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
