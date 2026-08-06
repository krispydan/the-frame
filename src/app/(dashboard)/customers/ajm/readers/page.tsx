"use client";

/**
 * Reading-glasses launch targets (/customers/ajm/readers)
 *
 * Jaxy's reader line launches Aug 2026. AJM's history names exactly which
 * retailers buy readers and how much they spent — this ranks them so the
 * launch push starts with the highest-intent accounts.
 */
import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { ArrowLeft, Glasses, Download, Search, Loader2 } from "lucide-react";
import Link from "next/link";

interface Target {
  groupKey: string; companyId: string | null; accountId: string | null;
  name: string; email: string | null; city: string | null; state: string | null;
  sources: string; readerRevenue: number; sunRevenue: number; totalRevenue: number;
  readerUnits: number; readerSharePct: number; orders: number;
  firstOrder: string | null; lastOrder: string | null;
  jaxyLtv: number | null; jaxyLastOrder: string | null; topReaderStyles: string;
}
interface CatRow { category: string; revenue: number; units: number }

const CAT_LABEL: Record<string, string> = {
  sun: "Sunglasses", reading: "Reading glasses", blue_light: "Blue-light readers",
  sunglass_reader: "Sunglass/bifocal readers", accessory: "Accessories",
  no_detail: "No line detail (legacy)", unclassified: "Unclassified",
};
const READER_CATS = ["reading", "blue_light", "sunglass_reader"];
const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

export default function ReaderTargetsPage() {
  const [data, setData] = useState<{ total: number; totals: { readerRevenue: number; customers: number }; targets: Target[] } | null>(null);
  const [cats, setCats] = useState<CatRow[]>([]);
  const [segment, setSegment] = useState<"reader_led" | "reader_heavy" | "any_reader">("reader_led");
  const [includeRetail, setIncludeRetail] = useState(false);
  const [noJaxy, setNoJaxy] = useState(false);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/v1/customers/ajm/readers?view=categories")
      .then((r) => r.json())
      .then((d) => setCats(d.overall ?? []))
      .catch(() => {});
  }, []);

  const params = useCallback(() => {
    const p = new URLSearchParams({ segment, limit: "300" });
    // Omit `sources` to inherit the canonical wholesale set (ajm/channels.ts).
    if (includeRetail) p.set("sources", "all");
    if (noJaxy) p.set("noJaxy", "1");
    if (q.trim()) p.set("q", q.trim());
    return p;
  }, [segment, includeRetail, noJaxy, q]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/customers/ajm/readers?${params()}`);
      setData(await res.json());
    } catch {
      toast.error("Failed to load reader targets");
    } finally {
      setLoading(false);
    }
  }, [params]);
  useEffect(() => { load(); }, [load]);

  const catTotal = cats.reduce((s, c) => s + c.revenue, 0);
  const readerRev = cats.filter((c) => READER_CATS.includes(c.category)).reduce((s, c) => s + c.revenue, 0);
  const sunRev = cats.find((c) => c.category === "sun")?.revenue ?? 0;
  const knownRev = readerRev + sunRev;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link href="/customers/ajm" className="text-muted-foreground hover:text-foreground"><ArrowLeft className="h-5 w-5" /></Link>
        <div className="flex-1">
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2"><Glasses className="h-7 w-7" /> Reading-Glasses Launch Targets</h1>
          <p className="text-muted-foreground">Retailers who bought readers from AJ Morgan — ranked by reader spend, for the Jaxy reader launch</p>
        </div>
        <a
          href={`/api/v1/customers/ajm/readers?${params()}&format=csv&limit=2000`}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border bg-background hover:bg-muted text-sm font-medium"
        >
          <Download className="h-4 w-4" /> Export CSV
        </a>
      </div>

      {/* The category story */}
      <Card>
        <CardHeader><CardTitle className="text-base">Why this matters — AJM&apos;s category mix</CardTitle></CardHeader>
        <CardContent>
          <div className="flex h-8 rounded overflow-hidden mb-3">
            {cats.filter((c) => c.revenue > 0).map((c) => (
              <div
                key={c.category}
                title={`${CAT_LABEL[c.category] ?? c.category}: ${money(c.revenue)}`}
                style={{ width: `${(c.revenue / catTotal) * 100}%` }}
                className={
                  c.category === "sun" ? "bg-blue-500"
                  : READER_CATS.includes(c.category) ? "bg-green-500"
                  : c.category === "accessory" ? "bg-purple-400"
                  : "bg-gray-300"
                }
              />
            ))}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Readers (all types)</p>
              <p className="text-xl font-bold text-green-600">{money(readerRev)}</p>
              <p className="text-xs text-muted-foreground">{knownRev > 0 ? `${((readerRev / knownRev) * 100).toFixed(0)}% of identified product revenue` : ""}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Sunglasses</p>
              <p className="text-xl font-bold text-blue-600">{money(sunRev)}</p>
              <p className="text-xs text-muted-foreground">{knownRev > 0 ? `${((sunRev / knownRev) * 100).toFixed(0)}% of identified` : ""}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Reader buyers (this filter)</p>
              <p className="text-xl font-bold">{(data?.total ?? 0).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Their reader spend</p>
              <p className="text-xl font-bold">{money(data?.totals.readerRevenue ?? 0)}</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Percentages are of revenue we could identify a product for. Excluded: legacy lump-sum orders billed as a single
            line with no product detail, and lines we couldn&apos;t classify — both shown in grey above and reported honestly
            rather than guessed at.
          </p>
        </CardContent>
      </Card>

      {/* Targets */}
      <Card>
        <CardHeader className="space-y-3">
          <CardTitle className="text-base">Targets</CardTitle>
          <div className="flex flex-col lg:flex-row gap-2 lg:items-center">
            <div className="inline-flex rounded-md border p-0.5 text-xs">
              {([
                ["reader_led", "Reader-led (readers > sun)"],
                ["reader_heavy", "Reader-heavy (≥50%)"],
                ["any_reader", "Any reader purchase"],
              ] as const).map(([k, label]) => (
                <button key={k} onClick={() => setSegment(k)}
                  className={`px-2.5 py-1 rounded ${segment === k ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}>
                  {label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={includeRetail} onChange={(e) => setIncludeRetail(e.target.checked)} />
              include retail consumers
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={noJaxy} onChange={(e) => setNoJaxy(e.target.checked)} />
              only those with no Jaxy orders
            </label>
            <div className="relative flex-1 lg:max-w-xs">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…"
                className="w-full rounded-md border pl-8 pr-2 py-1.5 text-sm" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {(data?.total ?? 0).toLocaleString()} matching customers{(data?.total ?? 0) > 300 ? " · showing top 300 by reader spend (CSV exports up to 2,000)" : ""}
          </p>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-10 text-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground inline" /></div>
          ) : (
            <Table>
              <TableHeader><TableRow>
                <TableHead>Customer</TableHead>
                <TableHead className="text-right">Reader spend</TableHead>
                <TableHead className="text-right">Reader share</TableHead>
                <TableHead>Top reader styles</TableHead>
                <TableHead className="text-right">Last AJM order</TableHead>
                <TableHead className="text-right">Jaxy LTV</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {(data?.targets ?? []).map((t) => (
                  <TableRow key={t.groupKey}>
                    <TableCell>
                      {t.accountId
                        ? <Link href={`/customers/${t.accountId}`} className="font-medium hover:underline">{t.name}</Link>
                        : <span className="font-medium">{t.name}</span>}
                      <div className="text-xs text-muted-foreground">
                        {[t.city, t.state].filter(Boolean).join(", ")}
                        {t.email ? ` · ${t.email}` : ""}
                        {!t.companyId ? " · not in Frame" : ""}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-semibold text-green-700">{money(t.readerRevenue)}</TableCell>
                    <TableCell className="text-right tabular-nums">{t.readerSharePct}%</TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[260px] truncate" title={t.topReaderStyles}>{t.topReaderStyles}</TableCell>
                    <TableCell className="text-right text-sm">{t.lastOrder ?? "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums ${t.jaxyLtv && t.jaxyLtv > 0 ? "" : "text-red-600"}`}>
                      {t.jaxyLtv && t.jaxyLtv > 0 ? money(t.jaxyLtv) : "$0"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
