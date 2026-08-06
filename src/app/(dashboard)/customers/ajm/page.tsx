"use client";

/**
 * AJ Morgan benchmark (/customers/ajm)
 *
 * AJM was a 40-year-old business that CEASED TRADING in Dec 2025. So this page
 * is not a competitor scoreboard — it's two things:
 *   1. a SEASONAL BENCHMARK for what this business can do in each month, and
 *   2. an ORPHANED CUSTOMER BOOK to capture (Jaxy employs the person who ran
 *      AJM's wholesale accounts).
 *
 * Design rules learned the hard way in this analysis:
 *   - Sunglasses are seasonal → never compare raw periods, always same months.
 *   - Wholesale = Shopify wholesale + Faire for BOTH brands (AJM ran Faire
 *     separately; Jaxy's Faire flows through the wholesale store).
 *   - Every chart should answer a decision, not just describe the past.
 */
import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { ArrowLeft, History, Search, Loader2, Glasses, Target, TrendingUp, ShoppingBag } from "lucide-react";
import Link from "next/link";
import { GroupedBarChart, LineChart } from "@/components/charts/simple-charts";

interface Bench {
  context: { ajmCeased: string; note: string; wholesaleDefinition: string };
  season: {
    start: string; end: string; mmddStart: string; mmddEnd: string;
    ajmYears: Array<{ year: string; total: number; retail: number; wholesale: number; orders: number; customers: number }>;
    jaxy: { total: number; retail: number; wholesale: number; amazon: number; orders: number; customers: number };
  };
  seasonality: Array<{ mo: string; ajmAvg: number }>;
  yoy: Array<{ mo: string; ajm2024: number; ajm2025: number; jaxy2026: number; ajmAvg: number }>;
  categories: Array<{ cat: string; revenue: number }>;
  orphans: {
    total: number; totalAjmRevenue: number;
    convertedCount: number; convertedAjmRevenue: number;
    notYetCount: number; notYetAjmRevenue: number;
    top: Array<{ companyId: string; name: string; accountId: string | null; ajmRevenue: number; ajmOrders: number; lastOrder: string; jaxyLtv: number; readerShare: number | null }>;
  };
}

const MON = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
const C = { ajm: "#94a3b8", ajm2: "#6366f1", jaxy: "#10b981", bench: "#f59e0b" };

/**
 * AJM's retail marketing mix, Q1 2025 — from AJM's Shopify Analytics
 * (last non-direct click), supplied by Daniel. NOT derivable from the order
 * exports, which carry no referrer/UTM data, so it lives here as a reference
 * benchmark for building Jaxy's retail engine.
 */
const RETAIL_PLAYBOOK = {
  period: "Q1 2025", sessions: 62131, sales: 77992.55, orders: 1640, convRate: 2.99, aov: 47.56,
  channels: [
    { name: "Google (paid)", sessions: 8280, sales: 29215.60, orders: 616, conv: 7.44 },
    { name: "Klaviyo (email)", sessions: 8674, sales: 23080.85, orders: 453, conv: 5.22 },
    { name: "Google Search (organic)", sessions: 9049, sales: 12042.40, orders: 266, conv: 2.94 },
    { name: "Direct", sessions: 27927, sales: 10088.60, orders: 224, conv: 0.8 },
    { name: "Instagram", sessions: 1454, sales: 1353.10, orders: 41, conv: 2.82 },
  ],
};

export default function AjmBenchmarkPage() {
  const [b, setB] = useState<Bench | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/customers/ajm/benchmark");
      if (res.ok) setB(await res.json());
      else toast.error("Failed to load AJM benchmark");
    } catch { toast.error("Failed to load AJM benchmark"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  if (!b) return <div className="p-6 text-muted-foreground">No data.</div>;

  const latestAjm = b.season.ajmYears[b.season.ajmYears.length - 1];
  const pct = (j: number, a: number) => (a > 0 ? Math.round((j / a) * 100) : 0);
  const catTotal = b.categories.reduce((s, c) => s + c.revenue, 0);
  const readers = b.categories.find((c) => c.cat === "readers")?.revenue ?? 0;
  const sun = b.categories.find((c) => c.cat === "sunglasses")?.revenue ?? 0;
  const orphanTop = b.orphans.top.filter((o) => !q.trim() || o.name.toLowerCase().includes(q.trim().toLowerCase()));
  const playbookTop2 = RETAIL_PLAYBOOK.channels[0].sales + RETAIL_PLAYBOOK.channels[1].sales;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link href="/customers" className="text-muted-foreground hover:text-foreground"><ArrowLeft className="h-5 w-5" /></Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2"><History className="h-7 w-7" /> AJ Morgan Benchmark</h1>
          <p className="text-muted-foreground">{b.context.note}</p>
        </div>
      </div>

      {/* ── 1. Season-matched scorecard: the only fair comparison ── */}
      <Card className="border-primary/30">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Target className="h-4 w-4" /> Where we stand — same season, {MON[+b.season.mmddStart.slice(0, 2)]} {b.season.mmddStart.slice(3)} → {MON[+b.season.mmddEnd.slice(0, 2)]} {b.season.mmddEnd.slice(3)}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {([
              { label: "Wholesale (Shopify + Faire)", jaxy: b.season.jaxy.wholesale, ajm: latestAjm?.wholesale ?? 0 },
              { label: "Retail (DTC)", jaxy: b.season.jaxy.retail, ajm: latestAjm?.retail ?? 0 },
              { label: "Total", jaxy: b.season.jaxy.total, ajm: latestAjm?.total ?? 0 },
            ]).map((r) => {
              const p = pct(r.jaxy, r.ajm);
              return (
                <div key={r.label} className="rounded-lg border p-4">
                  <p className="text-xs text-muted-foreground">{r.label}</p>
                  <p className="text-2xl font-bold">{money(r.jaxy)}</p>
                  <p className="text-xs text-muted-foreground">vs {money(r.ajm)} AJM {latestAjm?.year}</p>
                  <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
                    <div className={`h-full rounded-full ${p >= 60 ? "bg-green-500" : p >= 30 ? "bg-amber-500" : "bg-red-500"}`} style={{ width: `${Math.min(100, p)}%` }} />
                  </div>
                  <p className={`text-sm font-semibold mt-1 ${p >= 60 ? "text-green-600" : p >= 30 ? "text-amber-600" : "text-red-600"}`}>{p}% of AJM benchmark</p>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Wholesale = Shopify wholesale + Faire for both brands. Jaxy&apos;s Faire orders arrive through the wholesale
            store, and AJM ran Faire separately — comparing the Shopify stores alone would ignore AJM&apos;s Faire business.
          </p>
        </CardContent>
      </Card>

      {/* ── 2. AJM's season-window history: is the benchmark stable? ── */}
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><TrendingUp className="h-4 w-4" /> The benchmark is stable — AJM in this same window, every year</CardTitle></CardHeader>
        <CardContent>
          <GroupedBarChart
            data={[
              ...b.season.ajmYears.map((y) => ({ period: `AJM ${y.year}`, wholesale: y.wholesale, retail: y.retail })),
              { period: "Jaxy 2026", wholesale: b.season.jaxy.wholesale, retail: b.season.jaxy.retail },
            ] as unknown as Array<Record<string, string | number>>}
            xKey="period"
            height={260}
            series={[
              { key: "wholesale", label: "Wholesale (Shopify + Faire)", color: C.ajm2 },
              { key: "retail", label: "Retail (DTC)", color: C.bench },
            ]}
          />
          <p className="text-xs text-muted-foreground mt-2">
            AJM&apos;s wholesale sat near {money(latestAjm?.wholesale ?? 0)} in this window every year — a reliable target,
            not a moving one. Their retail only existed from 2024.
          </p>
        </CardContent>
      </Card>

      {/* ── 3. Seasonality: what to expect next, so a Q4 dip isn't read as failure ── */}
      <Card>
        <CardHeader><CardTitle className="text-base">Seasonality — what a normal year looks like</CardTitle></CardHeader>
        <CardContent>
          <LineChart
            data={b.yoy.map((r) => ({ period: MON[+r.mo], "AJM avg": r.ajmAvg, "AJM 2025": r.ajm2025, "Jaxy 2026": r.jaxy2026 })) as unknown as Array<Record<string, string | number>>}
            xKey="period"
            height={280}
            series={[
              { key: "AJM avg", label: "AJM average month (2021–25)", color: C.ajm },
              { key: "AJM 2025", label: "AJM 2025", color: C.ajm2 },
              { key: "Jaxy 2026", label: "Jaxy 2026", color: C.jaxy },
            ]}
          />
          <p className="text-xs text-muted-foreground mt-2">
            ⚠️ Peak is <strong>March–June</strong>; December runs about a third of peak. Jaxy launched 21 Apr — straight into
            the strongest months — so expect a natural decline into autumn/winter. That is seasonality, not a problem.
          </p>
        </CardContent>
      </Card>

      {/* ── 4. Same-month YoY: apples to apples ── */}
      <Card>
        <CardHeader><CardTitle className="text-base">Same month, year over year</CardTitle></CardHeader>
        <CardContent>
          <GroupedBarChart
            data={b.yoy.map((r) => ({ period: MON[+r.mo], ajm2024: r.ajm2024, ajm2025: r.ajm2025, jaxy2026: r.jaxy2026 })) as unknown as Array<Record<string, string | number>>}
            xKey="period"
            height={280}
            series={[
              { key: "ajm2024", label: "AJM 2024", color: C.ajm },
              { key: "ajm2025", label: "AJM 2025", color: C.ajm2 },
              { key: "jaxy2026", label: "Jaxy 2026", color: C.jaxy },
            ]}
          />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── 5. Category gap ── */}
        <Card className="border-green-200">
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Glasses className="h-4 w-4 text-green-600" /> The reading-glasses gap</CardTitle></CardHeader>
          <CardContent>
            <div className="flex h-8 rounded overflow-hidden mb-3">
              {b.categories.map((c) => (
                <div key={c.cat} title={`${c.cat}: ${money(c.revenue)}`} style={{ width: `${(c.revenue / catTotal) * 100}%` }}
                  className={c.cat === "sunglasses" ? "bg-sky-500" : c.cat === "readers" ? "bg-green-500" : c.cat === "accessories" ? "bg-purple-400" : "bg-gray-300"} />
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><p className="text-xs text-muted-foreground">Readers</p><p className="text-xl font-bold text-green-600">{money(readers)}</p></div>
              <div><p className="text-xs text-muted-foreground">Sunglasses</p><p className="text-xl font-bold text-sky-600">{money(sun)}</p></div>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Readers were <strong>{sun + readers > 0 ? Math.round((readers / (sun + readers)) * 100) : 0}%</strong> of AJM&apos;s
              identified product revenue — a category Jaxy hasn&apos;t sold until now.{" "}
              <Link href="/customers/ajm/readers" className="text-blue-600 hover:underline">Launch targets →</Link>
              {" "}Grey = legacy lump-sum orders with no line detail, plus lines we couldn&apos;t classify.
            </p>
          </CardContent>
        </Card>

        {/* ── 6. Retail playbook (the biggest relative gap) ── */}
        <Card className="border-amber-200">
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><ShoppingBag className="h-4 w-4 text-amber-600" /> AJM&apos;s retail playbook — how they got DTC sales</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-2 text-sm mb-3">
              <div><p className="text-xs text-muted-foreground">Conversion</p><p className="text-lg font-bold">{RETAIL_PLAYBOOK.convRate}%</p></div>
              <div><p className="text-xs text-muted-foreground">Retail AOV</p><p className="text-lg font-bold">${RETAIL_PLAYBOOK.aov}</p></div>
              <div><p className="text-xs text-muted-foreground">Sessions</p><p className="text-lg font-bold">{RETAIL_PLAYBOOK.sessions.toLocaleString()}</p></div>
            </div>
            <div className="space-y-1.5">
              {RETAIL_PLAYBOOK.channels.map((c) => {
                const share = (c.sales / RETAIL_PLAYBOOK.sales) * 100;
                return (
                  <div key={c.name}>
                    <div className="flex justify-between text-xs">
                      <span>{c.name}</span>
                      <span className="tabular-nums">{money(c.sales)} · {c.conv}% conv</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div className={`h-full ${c.conv >= 5 ? "bg-green-500" : c.conv >= 2.5 ? "bg-amber-500" : "bg-red-400"}`} style={{ width: `${share}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              <strong>Paid Google + Klaviyo email drove {Math.round((playbookTop2 / RETAIL_PLAYBOOK.sales) * 100)}% of attributed sales
              from 27% of sessions.</strong> Direct traffic was 45% of sessions but converted at 0.8%. Source: AJM Shopify
              Analytics, {RETAIL_PLAYBOOK.period} (last non-direct click) — not in the order exports, entered as a reference benchmark.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── 7. The orphaned book — Christina's worklist ── */}
      <Card>
        <CardHeader className="space-y-2">
          <CardTitle className="text-base flex items-center gap-2"><Target className="h-4 w-4" /> The orphaned book — AJM accounts, and how many we&apos;ve captured</CardTitle>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div><p className="text-xs text-muted-foreground">AJM accounts</p><p className="text-xl font-bold">{b.orphans.total.toLocaleString()}</p></div>
            <div><p className="text-xs text-muted-foreground">Converted to Jaxy</p><p className="text-xl font-bold text-green-600">{b.orphans.convertedCount.toLocaleString()}</p></div>
            <div><p className="text-xs text-muted-foreground">Not yet buying</p><p className="text-xl font-bold text-amber-600">{b.orphans.notYetCount.toLocaleString()}</p></div>
            <div><p className="text-xs text-muted-foreground">Their AJM revenue</p><p className="text-xl font-bold">{money(b.orphans.notYetAjmRevenue)}</p></div>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-green-500" style={{ width: `${(b.orphans.convertedCount / Math.max(1, b.orphans.total)) * 100}%` }} />
          </div>
          <div className="relative max-w-xs">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search accounts…" className="w-full rounded-md border pl-8 pr-2 py-1.5 text-sm" />
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow>
              <TableHead>Account</TableHead>
              <TableHead className="text-right">AJM revenue</TableHead>
              <TableHead className="text-right">Orders</TableHead>
              <TableHead className="text-right">Reader share</TableHead>
              <TableHead className="text-right">Last AJM order</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {orphanTop.map((o) => (
                <TableRow key={o.companyId}>
                  <TableCell>
                    {o.accountId
                      ? <Link href={`/customers/${o.accountId}`} className="font-medium hover:underline">{o.name}</Link>
                      : <span className="font-medium">{o.name}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-semibold">{money(o.ajmRevenue)}</TableCell>
                  <TableCell className="text-right tabular-nums">{o.ajmOrders}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {o.readerShare != null && o.readerShare >= 40
                      ? <span className="text-green-700 font-medium">{o.readerShare}%</span>
                      : <span className="text-muted-foreground">{o.readerShare ?? 0}%</span>}
                  </TableCell>
                  <TableCell className="text-right text-sm">{o.lastOrder}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-xs text-muted-foreground mt-2">
            Accounts with no Jaxy revenue yet, largest AJM spend first. Green reader share = lead with the reading-glasses
            launch. AJM ceased trading Dec 2025, so these are unserved, not lost to a competitor.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
