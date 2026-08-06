"use client";

/**
 * AJ Morgan history (/customers/ajm)
 *
 * Browse the acquired brand's customer base and compare AJM's sales against
 * Jaxy's, per channel and per customer. The "Win-back" tab is the sales
 * hit-list: bought from AJM, exists in the Frame, hasn't bought from Jaxy.
 */
import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { ArrowLeft, History, Users, Search, Loader2, TrendingUp } from "lucide-react";
import Link from "next/link";

interface SourceStat {
  source: string; orders: number; units: number; revenue: number;
  matchedOrders: number; customers: number; firstOrder: string | null; lastOrder: string | null;
}
interface YearRow { year: string; source?: string; grp?: string; revenue: number; orders: number }
interface TopProduct { product: string; units: number; revenue: number }
interface AjmCustomer {
  groupKey: string; companyId: string | null; companyName: string | null; rawName: string | null;
  accountId: string | null; jaxyLtv: number | null; jaxyLastOrder: string | null;
  ajmOrders: number; ajmUnits: number; ajmRevenue: number;
  firstOrder: string | null; lastOrder: string | null; sources: string;
}

const SOURCE_LABEL: Record<string, string> = {
  faire: "Faire",
  shopify_wholesale: "Shopify Wholesale",
  shopify_retail: "Shopify Retail",
  oms: "OMS / Phone",
};

function money(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

export default function AjmHistoryPage() {
  const [summary, setSummary] = useState<{
    bySource: SourceStat[]; ajmByYear: YearRow[]; jaxyByYear: YearRow[]; topProducts: TopProduct[];
  } | null>(null);
  const [customers, setCustomers] = useState<AjmCustomer[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<"all" | "matched" | "unmatched" | "dormant">("all");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingCustomers, setLoadingCustomers] = useState(false);

  useEffect(() => {
    fetch("/api/v1/customers/ajm?view=summary")
      .then((r) => r.json())
      .then(setSummary)
      .catch(() => toast.error("Failed to load AJM summary"))
      .finally(() => setLoading(false));
  }, []);

  const loadCustomers = useCallback(async () => {
    setLoadingCustomers(true);
    try {
      const res = await fetch(`/api/v1/customers/ajm?view=customers&filter=${filter}&q=${encodeURIComponent(q)}&limit=200`);
      const d = await res.json();
      setCustomers(d.customers ?? []);
      setTotal(d.total ?? 0);
    } catch {
      toast.error("Failed to load AJM customers");
    } finally {
      setLoadingCustomers(false);
    }
  }, [filter, q]);
  useEffect(() => { loadCustomers(); }, [loadCustomers]);

  if (loading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  const totalRevenue = (summary?.bySource ?? []).reduce((s, r) => s + r.revenue, 0);
  const years = [...new Set([...(summary?.ajmByYear ?? []).map((r) => r.year), ...(summary?.jaxyByYear ?? []).map((r) => r.year)])].sort();
  const ajmYearTotal = (y: string, pred: (r: YearRow) => boolean = () => true) =>
    (summary?.ajmByYear ?? []).filter((r) => r.year === y && pred(r)).reduce((s, r) => s + r.revenue, 0);
  const jaxyYearTotal = (y: string, pred: (r: YearRow) => boolean = () => true) =>
    (summary?.jaxyByYear ?? []).filter((r) => r.year === y && pred(r)).reduce((s, r) => s + r.revenue, 0);

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link href="/customers" className="text-muted-foreground hover:text-foreground"><ArrowLeft className="h-5 w-5" /></Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2"><History className="h-7 w-7" /> AJ Morgan History</h1>
          <p className="text-muted-foreground">The acquired brand&apos;s {money(totalRevenue)} in historical sales — compare channels, browse customers, find win-backs</p>
        </div>
      </div>

      {/* Per-source cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {(summary?.bySource ?? []).map((s) => (
          <Card key={s.source}><CardContent className="pt-6">
            <p className="text-xs text-muted-foreground">{SOURCE_LABEL[s.source] ?? s.source}</p>
            <p className="text-2xl font-bold">{money(s.revenue)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {s.orders.toLocaleString()} orders · {s.customers.toLocaleString()} customers · {s.firstOrder?.slice(0, 4)}–{s.lastOrder?.slice(0, 4)}
            </p>
          </CardContent></Card>
        ))}
      </div>

      {/* AJM vs Jaxy by year */}
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><TrendingUp className="h-4 w-4" /> AJM vs Jaxy — revenue by year</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow>
              <TableHead>Year</TableHead>
              <TableHead className="text-right">AJM Wholesale</TableHead>
              <TableHead className="text-right">AJM Faire</TableHead>
              <TableHead className="text-right">AJM Retail</TableHead>
              <TableHead className="text-right">AJM Total</TableHead>
              <TableHead className="text-right border-l">Jaxy Wholesale</TableHead>
              <TableHead className="text-right">Jaxy Faire</TableHead>
              <TableHead className="text-right">Jaxy Retail</TableHead>
              <TableHead className="text-right">Jaxy Total</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {years.map((y) => {
                const ajmTotal = ajmYearTotal(y);
                const jxTotal = jaxyYearTotal(y);
                return (
                  <TableRow key={y}>
                    <TableCell className="font-medium">{y}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(ajmYearTotal(y, (r) => r.source === "shopify_wholesale" || r.source === "oms"))}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(ajmYearTotal(y, (r) => r.source === "faire"))}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(ajmYearTotal(y, (r) => r.source === "shopify_retail"))}</TableCell>
                    <TableCell className="text-right tabular-nums font-semibold">{money(ajmTotal)}</TableCell>
                    <TableCell className="text-right tabular-nums border-l">{money(jaxyYearTotal(y, (r) => r.grp === "wholesale"))}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(jaxyYearTotal(y, (r) => r.grp === "faire"))}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(jaxyYearTotal(y, (r) => r.grp === "retail"))}</TableCell>
                    <TableCell className={`text-right tabular-nums font-semibold ${jxTotal >= ajmTotal ? "text-green-600" : ""}`}>{money(jxTotal)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <p className="text-xs text-muted-foreground mt-2">
            AJM Faire revenue is wholesale-price line totals (Faire order-total where the payouts export covered it). Jaxy channels grouped to match: wholesale = Shopify Wholesale + direct + phone.
          </p>
        </CardContent>
      </Card>

      {/* Top AJM products */}
      <Card>
        <CardHeader><CardTitle className="text-base">Top AJM Products (lifetime)</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-1">
            {(summary?.topProducts ?? []).map((p, i) => (
              <div key={p.product} className="flex items-baseline justify-between text-sm py-0.5 border-b last:border-0">
                <span className="truncate mr-2"><span className="text-muted-foreground mr-1.5">{i + 1}.</span>{p.product}</span>
                <span className="tabular-nums whitespace-nowrap">{money(p.revenue)} · {p.units.toLocaleString()}u</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Customer browser */}
      <Card>
        <CardHeader className="space-y-3">
          <CardTitle className="text-base flex items-center gap-2"><Users className="h-4 w-4" /> AJM Customers</CardTitle>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <div className="inline-flex rounded-md border p-0.5 text-xs">
              {([
                ["all", "All"],
                ["matched", "In the Frame"],
                ["dormant", "Win-back (no Jaxy orders)"],
                ["unmatched", "Not matched"],
              ] as const).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setFilter(k)}
                  className={`px-2.5 py-1 rounded ${filter === k ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="relative flex-1 sm:max-w-xs">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search customers…"
                className="w-full rounded-md border pl-8 pr-2 py-1.5 text-sm"
              />
            </div>
            <span className="text-xs text-muted-foreground">{total.toLocaleString()} customers{total > 200 ? " · showing top 200 by AJM revenue" : ""}</span>
          </div>
        </CardHeader>
        <CardContent>
          {loadingCustomers ? (
            <div className="py-10 text-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground inline" /></div>
          ) : (
            <Table>
              <TableHeader><TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Channels</TableHead>
                <TableHead className="text-right">AJM Revenue</TableHead>
                <TableHead className="text-right">AJM Orders</TableHead>
                <TableHead className="text-right">Last AJM Order</TableHead>
                <TableHead className="text-right">Jaxy LTV</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {customers.map((c) => (
                  <TableRow key={c.groupKey}>
                    <TableCell>
                      {c.accountId ? (
                        <Link href={`/customers/${c.accountId}`} className="font-medium hover:underline">{c.companyName ?? c.rawName}</Link>
                      ) : (
                        <span className="font-medium">{c.companyName ?? c.rawName ?? "—"}</span>
                      )}
                      {!c.companyId && <span className="ml-1.5 text-[10px] text-muted-foreground align-middle">not in Frame</span>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {c.sources.split(",").map((s) => SOURCE_LABEL[s] ?? s).join(", ")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-semibold">{money(c.ajmRevenue)}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.ajmOrders}</TableCell>
                    <TableCell className="text-right text-sm">{c.lastOrder ?? "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums ${c.jaxyLtv && c.jaxyLtv > 0 ? "" : "text-red-600"}`}>
                      {c.jaxyLtv && c.jaxyLtv > 0 ? money(c.jaxyLtv) : "$0"}
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
