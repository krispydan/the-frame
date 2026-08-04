"use client";

/**
 * Amazon channel dashboard.
 *
 * Designed around one fact: gross sales are misleading for this channel.
 * Promotions ran at 71% of gross during launch, so a page leading with
 * revenue would suggest a healthy business where the settlement nets to
 * roughly zero. Promotions therefore sit next to gross everywhere, and
 * contribution margin — net of fees and COGS — is the headline number.
 */

import { useState, useEffect, useCallback } from "react";
import {
  RefreshCw, AlertTriangle, CheckCircle, TrendingDown, Package,
  Percent, DollarSign, ShoppingCart, Boxes, ExternalLink,
} from "lucide-react";

interface Headline {
  grossSales: number; promotions: number; promotionsPctOfGross: number | null;
  netSales: number; units: number; orders: number; refunds: number;
  refundRatePct: number | null; referralFees: number; fbaFees: number;
  otherFees: number; totalFees: number; feeLoadPct: number | null;
  cogs: number; contributionMargin: number; contributionMarginPct: number | null;
  hasFullCostData: boolean;
}
interface DailyPoint {
  date: string; grossSales: number; promotions: number; netSales: number;
  unitsOrdered: number; unitsShipped: number; sessions: number | null;
  pageViews: number | null; buyBoxPct: number | null; conversionRate: number | null;
}
interface SkuRow {
  sku: string; internalSku: string | null; units: number; revenue: number;
  cogs: number; contribution: number; fbaFulfillable: number | null; fbaInbound: number | null;
}
interface SettlementRow {
  settlementId: string; periodStart: string | null; periodEnd: string | null;
  gross: number; fees: number; adjustments: number; net: number;
  status: string; receivedAt: string | null; xeroTransactionId: string | null;
}
interface InventoryRow {
  sku: string; internalSku: string | null; fbaFulfillable: number; fbaInbound: number;
  fbaReserved: number; fbaUnsellable: number; fbaTotal: number;
  warehouseOnHand: number | null; totalOwned: number;
}
interface SyncHealthRow {
  reportName: string; lastStatus: string | null; lastSuccessAt: string | null;
  lastSyncedThrough: string | null; consecutiveFailures: number; lastError: string | null;
}
interface Payload {
  ok: boolean;
  range: { from: string; to: string; preset: string };
  configured: boolean;
  headline: Headline;
  daily: DailyPoint[];
  skus: SkuRow[];
  settlements: SettlementRow[];
  inventory: InventoryRow[];
  syncHealth: SyncHealthRow[];
  unmappedSkus: Array<{ sku: string; units: number }>;
}

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const pctStr = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)}%`);

const RANGES = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
  { key: "mtd", label: "Month to date" },
  { key: "all", label: "All time" },
];

export default function AmazonDashboardPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState("30d");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/finance/amazon?range=${range}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Request failed");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { void load(); }, [load]);

  if (loading && !data) {
    return <div className="p-6 text-sm text-muted-foreground">Loading Amazon channel…</div>;
  }
  if (error) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <div className="font-medium">Could not load Amazon metrics</div>
          <div className="mt-1">{error}</div>
          <button onClick={() => void load()} className="mt-3 rounded border px-3 py-1.5 text-xs font-medium hover:bg-red-100">
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (!data) return null;

  const h = data.headline;
  const maxDaily = Math.max(1, ...data.daily.map((d) => d.grossSales));

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Amazon</h1>
          <p className="text-sm text-muted-foreground">
            {data.range.from} → {data.range.to} · fulfilled by Amazon, not ShipHero
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={range}
            onChange={(e) => setRange(e.target.value)}
            className="rounded-lg border bg-background px-3 py-1.5 text-sm"
          >
            {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
          <button
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm hover:bg-muted"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Problems worth seeing before any numbers */}
      {!data.configured && (
        <Banner tone="warn" icon={AlertTriangle}
          title="WINDSOR_API_KEY is not set"
          body="No new Amazon data can be pulled until it is configured. Figures below are whatever has already been archived." />
      )}
      {data.unmappedSkus.length > 0 && (
        <Banner tone="warn" icon={AlertTriangle}
          title={`${data.unmappedSkus.length} Amazon SKU${data.unmappedSkus.length === 1 ? "" : "s"} cannot be costed`}
          body={`These do not resolve to a catalog SKU, so their COGS is missing and margin below is optimistic: ${data.unmappedSkus.slice(0, 8).map((s) => s.sku).join(", ")}${data.unmappedSkus.length > 8 ? "…" : ""}`} />
      )}
      {!h.hasFullCostData && data.unmappedSkus.length === 0 && (
        <Banner tone="info" icon={AlertTriangle}
          title="Some sold units have no cost attached"
          body="Contribution margin is optimistic until the daily COGS run has costed every shipped unit in this period." />
      )}

      {/* Headline */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Gross sales" value={money(h.grossSales)} icon={DollarSign} />
        <Stat
          label="Promotions"
          value={money(h.promotions)}
          sub={h.promotionsPctOfGross === null ? undefined : `${pctStr(h.promotionsPctOfGross)} of gross`}
          icon={Percent}
          // Launch discounting is the single most important fact about this
          // channel's economics, so it is called out rather than buried.
          tone={(h.promotionsPctOfGross ?? 0) > 40 ? "warn" : "default"}
        />
        <Stat label="Net sales" value={money(h.netSales)} sub="after promotions" icon={TrendingDown} />
        <Stat
          label="Contribution"
          value={money(h.contributionMargin)}
          sub={`${pctStr(h.contributionMarginPct)} of net · after fees & COGS`}
          icon={DollarSign}
          tone={h.contributionMargin < 0 ? "bad" : "good"}
        />
        <Stat label="Units" value={String(h.units)} icon={Package} />
        <Stat label="Orders" value={String(h.orders)} icon={ShoppingCart} />
        <Stat
          label="Amazon fees"
          value={money(h.totalFees)}
          sub={`${pctStr(h.feeLoadPct)} of gross · referral ${money(h.referralFees)} · FBA ${money(h.fbaFees)}`}
          icon={Percent}
        />
        <Stat label="Refunds" value={money(h.refunds)} sub={`${pctStr(h.refundRatePct)} of net`} icon={TrendingDown} />
      </div>

      {/* Daily: gross vs promotions vs net */}
      <Card title="Daily sales — gross, promotions and net"
            hint="The gap between the bars is what launch discounting is costing.">
        {data.daily.length === 0 ? (
          <Empty>No sales in this period.</Empty>
        ) : (
          <div className="space-y-1">
            {data.daily.map((d) => (
              <div key={d.date} className="flex items-center gap-3 text-xs">
                <span className="w-20 shrink-0 tabular-nums text-muted-foreground">{d.date}</span>
                <div className="relative h-4 flex-1 overflow-hidden rounded bg-muted">
                  <div className="absolute inset-y-0 left-0 bg-blue-200 dark:bg-blue-900"
                       style={{ width: `${(d.grossSales / maxDaily) * 100}%` }} />
                  <div className="absolute inset-y-0 left-0 bg-blue-600"
                       style={{ width: `${(d.netSales / maxDaily) * 100}%` }} />
                </div>
                <span className="w-20 shrink-0 text-right tabular-nums">{money(d.netSales)}</span>
                <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
                  {d.promotions > 0 ? `−${money(d.promotions)}` : ""}
                </span>
                <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                  {d.unitsOrdered}u
                </span>
              </div>
            ))}
            <div className="flex items-center gap-4 pt-2 text-xs text-muted-foreground">
              <Legend className="bg-blue-600" label="Net sales" />
              <Legend className="bg-blue-200 dark:bg-blue-900" label="Promotions (gap to gross)" />
            </div>
          </div>
        )}
      </Card>

      {/* Traffic — Amazon-only metrics available nowhere else */}
      <Card title="Traffic & conversion" hint="Sessions, Buy Box share and conversion come only from Amazon.">
        {data.daily.every((d) => d.sessions === null) ? (
          <Empty>No traffic data yet — the sales &amp; traffic report has not been pulled for this period.</Empty>
        ) : (
          <Table
            head={["Date", "Sessions", "Page views", "Buy Box", "Conversion", "Units shipped"]}
            rows={data.daily.filter((d) => d.sessions !== null).map((d) => [
              d.date,
              d.sessions === null ? "—" : String(d.sessions),
              d.pageViews === null ? "—" : String(d.pageViews),
              pctStr(d.buyBoxPct),
              pctStr(d.conversionRate),
              String(d.unitsShipped),
            ])}
          />
        )}
      </Card>

      {/* SKUs */}
      <Card title="Top SKUs" hint="Contribution is revenue less costed COGS. FBA stock shown so a strong seller running low is obvious.">
        {data.skus.length === 0 ? <Empty>No SKUs sold in this period.</Empty> : (
          <Table
            head={["SKU", "Units", "Revenue", "COGS", "Contribution", "FBA on hand", "Inbound"]}
            rows={data.skus.map((s) => [
              s.sku, String(s.units), money(s.revenue),
              s.cogs === 0 ? "—" : money(s.cogs),
              money(s.contribution),
              s.fbaFulfillable === null ? "—" : String(s.fbaFulfillable),
              s.fbaInbound === null ? "—" : String(s.fbaInbound),
            ])}
          />
        )}
      </Card>

      {/* Inventory position — the gap ShipHero cannot see */}
      <Card
        title="Inventory position"
        hint="ShipHero's on-hand drops when units ship to Amazon, so without the FBA column the business looks like it owns fewer units than it does."
        icon={Boxes}
      >
        {data.inventory.length === 0 ? <Empty>No FBA inventory snapshot yet.</Empty> : (
          <Table
            head={["SKU", "FBA available", "FBA inbound", "Reserved", "Unsellable", "ShipHero", "Total owned"]}
            rows={data.inventory.slice(0, 25).map((i) => [
              i.sku, String(i.fbaFulfillable), String(i.fbaInbound), String(i.fbaReserved),
              String(i.fbaUnsellable),
              i.warehouseOnHand === null ? "—" : String(i.warehouseOnHand),
              String(i.totalOwned),
            ])}
          />
        )}
      </Card>

      {/* Settlements */}
      <Card title="Settlements" hint="Net must tie to the bank deposit.">
        {data.settlements.length === 0 ? <Empty>No settlements bridged yet.</Empty> : (
          <Table
            head={["Settlement", "Period", "Gross", "Fees", "Adjustments", "Net", "Status", "Xero"]}
            rows={data.settlements.map((s) => [
              s.settlementId,
              `${s.periodStart ?? "?"} → ${s.periodEnd ?? "?"}`,
              money(s.gross), money(s.fees), money(s.adjustments), money(s.net),
              s.status,
              s.xeroTransactionId ? "posted" : "not posted",
            ])}
          />
        )}
      </Card>

      {/* Sync health — Windsor's Amazon reports are genuinely unreliable */}
      <Card title="Sync health" hint="Windsor's Amazon reports fail intermittently; this is where that becomes visible instead of silent.">
        {data.syncHealth.length === 0 ? <Empty>No syncs have run yet.</Empty> : (
          <div className="space-y-2">
            {data.syncHealth.map((s) => (
              <div key={s.reportName} className="flex flex-wrap items-center gap-3 rounded border px-3 py-2 text-sm">
                {s.lastStatus === "ok"
                  ? <CheckCircle className="h-4 w-4 shrink-0 text-green-600" />
                  : <AlertTriangle className={`h-4 w-4 shrink-0 ${s.consecutiveFailures >= 3 ? "text-red-600" : "text-amber-500"}`} />}
                <span className="font-medium">{s.reportName}</span>
                <span className="text-muted-foreground">
                  through {s.lastSyncedThrough ?? "—"} · last ok {s.lastSuccessAt?.slice(0, 16) ?? "never"}
                </span>
                {s.consecutiveFailures > 0 && (
                  <span className={s.consecutiveFailures >= 3 ? "text-red-600" : "text-amber-600"}>
                    {s.consecutiveFailures} consecutive failure{s.consecutiveFailures === 1 ? "" : "s"}
                  </span>
                )}
                {s.lastError && (
                  <span className="w-full truncate text-xs text-muted-foreground" title={s.lastError}>
                    {s.lastError}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ExternalLink className="h-3 w-3" />
        <a className="underline" href="https://sellercentral.amazon.com" target="_blank" rel="noopener noreferrer">
          Open Seller Central
        </a>
      </p>
    </div>
  );
}

// ── Presentational helpers ──

function Stat({ label, value, sub, icon: Icon, tone = "default" }: {
  label: string; value: string; sub?: string;
  icon: React.ElementType; tone?: "default" | "good" | "bad" | "warn";
}) {
  const toneClass =
    tone === "bad" ? "text-red-600"
      : tone === "good" ? "text-green-700 dark:text-green-500"
        : tone === "warn" ? "text-amber-600"
          : "";
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Card({ title, hint, icon: Icon, children }: {
  title: string; hint?: string; icon?: React.ElementType; children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-background">
      <div className="border-b px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {Icon && <Icon className="h-4 w-4" />}
          {title}
        </h2>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            {head.map((h) => <th key={h} className="pb-2 pr-4 font-medium whitespace-nowrap">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b last:border-0">
              {r.map((c, j) => (
                <td key={j} className={`py-2 pr-4 whitespace-nowrap ${j === 0 ? "font-medium" : "tabular-nums"}`}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Banner({ tone, icon: Icon, title, body }: {
  tone: "warn" | "info"; icon: React.ElementType; title: string; body: string;
}) {
  const cls = tone === "warn"
    ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
    : "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200";
  return (
    <div className={`flex gap-3 rounded-lg border p-3 text-sm ${cls}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <div className="font-medium">{title}</div>
        <div className="mt-0.5 text-xs">{body}</div>
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-4 text-center text-sm text-muted-foreground">{children}</p>;
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block h-2 w-3 rounded-sm ${className}`} />
      {label}
    </span>
  );
}
