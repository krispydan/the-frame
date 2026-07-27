"use client";

/**
 * Dashboard widget bodies. Each is a pure presentational component consuming
 * its slice of the /api/v1/dashboard bundle. The page wraps most of them in a
 * WidgetFrame (title + link + customize chrome); the KPI strip renders its own
 * tiles full-width.
 */

import { StatTile } from "@/components/dashboard/stat-tile";
import { AreaTrend, Donut, HBars, Meter } from "@/components/dashboard/charts";
import { Delta } from "@/components/dashboard/delta";
import { money, num, pct, deltaPct } from "@/components/dashboard/format";
import { seriesColor, channelColor, channelLabel, STATUS } from "@/components/dashboard/palette";
import {
  DollarSign, ShoppingCart, Receipt, TrendingUp, TrendingDown, PackageX, Megaphone,
  AlertTriangle, Phone, Mail, Facebook, Sparkles, Target, Activity as ActivityIcon,
} from "lucide-react";

export type Bundle = {
  role: string;
  range: string;
  widgets: Record<string, unknown>;
  /** True when the server served this from its stale-while-revalidate cache. */
  cached?: boolean;
  /** When the payload was actually computed (epoch ms). */
  builtAt?: number;
};

const g = <T,>(b: Bundle, k: string): T | undefined => b.widgets[k] as T | undefined;

// ── KPI strip ──
type Kpis = {
  revenue: number; priorRevenue: number; orders: number; priorOrders: number;
  aov: number; priorAov: number; pipelineValue: number; openDeals: number;
  lowStock: number; inventoryUnits: number; newLeads: number;
};
export function KpisWidget({ data }: { data: Bundle }) {
  const k = g<Kpis>(data, "kpis");
  const role = data.role;
  if (!k) return null;
  const can = (roles: string[]) => role === "owner" || roles.includes(role);
  const tiles: React.ReactNode[] = [
    <StatTile key="rev" label="Revenue" value={money(k.revenue, { compact: k.revenue >= 100000 })} icon={DollarSign} accent={seriesColor(0)} delta={deltaPct(k.revenue, k.priorRevenue)} sub="vs prior period" href="/finance" />,
    <StatTile key="ord" label="Orders" value={num(k.orders)} icon={ShoppingCart} accent={seriesColor(2)} delta={deltaPct(k.orders, k.priorOrders)} href="/orders" />,
    <StatTile key="aov" label="Avg order value" value={money(k.aov)} icon={Receipt} accent={seriesColor(4)} delta={deltaPct(k.aov, k.priorAov)} />,
  ];
  if (can(["sales_manager"])) tiles.push(<StatTile key="pipe" label="Open pipeline" value={money(k.pipelineValue, { compact: true })} icon={TrendingUp} accent={seriesColor(5)} sub={`${num(k.openDeals)} open deals`} href="/prospects" />);
  if (can(["warehouse"])) tiles.push(<StatTile key="low" label="Low stock SKUs" value={num(k.lowStock)} icon={PackageX} accent={STATUS.serious} deltaGoodWhenUp={false} sub={`${num(k.inventoryUnits)} units on hand`} href="/inventory" />);
  if (can(["marketing", "sales_manager"])) tiles.push(<StatTile key="leads" label="New leads" value={num(k.newLeads)} icon={Megaphone} accent={seriesColor(1)} sub="Facebook/Instagram" href="/prospects" />);
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">{tiles}</div>;
}

// ── Targets ──
type TargetRow = {
  metric: string; label: string; unit: "currency" | "count" | "percent";
  target: number; actual: number; attainmentPct: number | null;
  elapsedPct: number; projectedVsTargetPct: number | null; status: string; periodLabel: string;
};
const TARGET_TONE: Record<string, string> = {
  ahead: STATUS.good, on_track: STATUS.good, hit: STATUS.good,
  behind: STATUS.warn, at_risk: STATUS.critical, missed: STATUS.critical,
};
function fmtTarget(v: number | null, unit: string): string {
  if (v == null) return "—";
  if (unit === "currency") return money(v, { compact: Math.abs(v) >= 10000 });
  if (unit === "percent") return pct(v, 1);
  return num(Math.round(v));
}
export function TargetsWidget({ data }: { data: Bundle }) {
  const rows = g<TargetRow[]>(data, "targets") ?? [];
  if (!rows.length) {
    return (
      <div className="flex h-28 flex-col items-center justify-center gap-1 text-center">
        <Target className="h-5 w-5 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No targets set for this month.</p>
        <a href="/targets" className="text-xs text-primary hover:underline">Set the plan →</a>
      </div>
    );
  }
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => {
        const tone = TARGET_TONE[r.status] ?? STATUS.neutral;
        const attain = Math.max(0, Math.min(100, r.attainmentPct ?? 0));
        return (
          <li key={r.metric} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate font-medium">{r.label}</span>
              <span className="shrink-0 tabular-nums">
                {fmtTarget(r.actual, r.unit)}
                <span className="text-muted-foreground"> / {fmtTarget(r.target, r.unit)}</span>
              </span>
            </div>
            {/* Fill = attainment; the tick marks where we should be by now. */}
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full transition-all" style={{ width: `${attain}%`, backgroundColor: tone }} />
              <span className="absolute top-0 h-full w-0.5 bg-foreground/50" style={{ left: `${Math.min(100, r.elapsedPct * 100)}%` }} title="Pace — where we should be today" />
            </div>
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span style={{ color: tone }}>{(r.attainmentPct ?? 0).toFixed(0)}% of target</span>
              {r.projectedVsTargetPct != null && (
                <span>projected {r.projectedVsTargetPct >= 0 ? "+" : ""}{r.projectedVsTargetPct.toFixed(0)}%</span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ── Revenue trend ──
export function RevenueTrendWidget({ data }: { data: Bundle }) {
  const rows = g<Array<{ label: string; value: number }>>(data, "revenueTrend") ?? [];
  const total = rows.reduce((a, r) => a + r.value, 0);
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-semibold tabular-nums">{money(total, { compact: total >= 100000 })}</span>
        <span className="text-xs text-muted-foreground">total this range</span>
      </div>
      <AreaTrend data={rows} color={seriesColor(0)} format={(v) => money(v)} />
    </div>
  );
}

// ── Channel mix ──
export function ChannelMixWidget({ data }: { data: Bundle }) {
  const rows = g<Array<{ channel: string; revenue: number; orders: number }>>(data, "channelMix") ?? [];
  const slices = rows.map((r) => ({ label: channelLabel(r.channel), value: r.revenue, color: channelColor(r.channel) }));
  return <Donut slices={slices} centerLabel={money(rows.reduce((a, r) => a + r.revenue, 0), { compact: true })} />;
}

// ── Top sellers (wholesale vs retail split) ──
type TopSeller = {
  sku: string; name: string; color: string; units: number; revenue: number;
  unitsWholesale: number; unitsRetail: number; wholesaleSharePct: number;
  avgOrderQty: number; accounts: number;
};
type ProductInsight = {
  topSellers: TopSeller[];
  movers: {
    rising: Array<{ sku: string; name: string; color: string; trendPct: number | null; units: number; daysCover: number | null }>;
    falling: Array<{ sku: string; name: string; color: string; trendPct: number | null; units: number; daysCover: number | null }>;
    breakout: Array<{ sku: string; name: string; color: string; units: number }>;
  };
  wholesaleSharePct: number;
};

const WHOLESALE_COLOR = seriesColor(0);
const RETAIL_COLOR = seriesColor(1);

export function TopSellersWidget({ data }: { data: Bundle }) {
  const insight = g<ProductInsight>(data, "productInsight");
  const rows = insight?.topSellers ?? [];
  if (!rows.length) return <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">No sales in this range</div>;
  const max = Math.max(...rows.map((r) => r.units), 1);
  return (
    <div className="space-y-3">
      {/* Legend — identity is never color-alone */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm" style={{ backgroundColor: WHOLESALE_COLOR }} /> Wholesale</span>
        <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm" style={{ backgroundColor: RETAIL_COLOR }} /> Retail</span>
        {insight && <span className="ml-auto">{pct(insight.wholesaleSharePct)} wholesale overall</span>}
      </div>
      <ul className="space-y-2.5">
        {rows.map((r) => {
          const wPct = (r.unitsWholesale / max) * 100;
          const rPct = (r.unitsRetail / max) * 100;
          return (
            <li key={r.sku} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate font-medium">{r.name}<span className="text-muted-foreground"> · {r.color}</span></span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {money(r.revenue, { compact: r.revenue >= 10000 })}<span className="ml-1 text-xs">{num(r.units)} u</span>
                </span>
              </div>
              {/* Stacked units bar: 2px gap between segments per chart spec */}
              <div className="flex h-2 w-full gap-[2px] overflow-hidden rounded-full bg-muted">
                {r.unitsWholesale > 0 && <div className="h-full rounded-full" style={{ width: `${Math.max(2, wPct)}%`, backgroundColor: WHOLESALE_COLOR }} />}
                {r.unitsRetail > 0 && <div className="h-full rounded-full" style={{ width: `${Math.max(2, rPct)}%`, backgroundColor: RETAIL_COLOR }} />}
              </div>
              <div className="flex gap-3 text-[11px] text-muted-foreground">
                <span>{pct(r.wholesaleSharePct)} wholesale</span>
                <span>{r.avgOrderQty.toFixed(1)} avg qty/order</span>
                {r.accounts > 0 && <span>{num(r.accounts)} {r.accounts === 1 ? "door" : "doors"}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── Rising & falling ──
export function MoversWidget({ data }: { data: Bundle }) {
  const insight = g<ProductInsight>(data, "productInsight");
  const m = insight?.movers;
  if (!m || (!m.rising.length && !m.falling.length && !m.breakout.length)) {
    return <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">Not enough volume to detect trends yet</div>;
  }
  const Row = ({ r, up }: { r: { sku: string; name: string; color: string; trendPct?: number | null; units: number; daysCover?: number | null }; up: boolean }) => (
    <li className="flex items-center justify-between gap-2 py-1 text-sm">
      <div className="min-w-0">
        <span className="truncate font-medium">{r.name}</span>
        <span className="text-muted-foreground"> · {r.color}</span>
        <span className="ml-1 text-[11px] text-muted-foreground">{num(r.units)} u</span>
      </div>
      <span className="flex shrink-0 items-center gap-1.5">
        {/* A rising seller with thin cover is a stockout risk, not just a win */}
        {up && r.daysCover != null && r.daysCover < 30 && (
          <span className="rounded px-1 text-[10px] font-medium" style={{ backgroundColor: `${STATUS.serious}1a`, color: STATUS.serious }}>
            {r.daysCover}d cover
          </span>
        )}
        {r.trendPct != null && <Delta value={r.trendPct} goodWhenUp />}
      </span>
    </li>
  );
  return (
    <div className="space-y-3">
      {m.rising.length > 0 && (
        <div>
          <div className="mb-0.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><TrendingUp className="h-3.5 w-3.5" /> Gaining</div>
          <ul className="divide-y">{m.rising.map((r) => <Row key={r.sku} r={r} up />)}</ul>
        </div>
      )}
      {m.falling.length > 0 && (
        <div>
          <div className="mb-0.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><TrendingDown className="h-3.5 w-3.5" /> Slipping</div>
          <ul className="divide-y">{m.falling.map((r) => <Row key={r.sku} r={r} up={false} />)}</ul>
        </div>
      )}
      {m.breakout.length > 0 && (
        <div>
          <div className="mb-0.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Sparkles className="h-3.5 w-3.5" /> New this period</div>
          <ul className="divide-y">{m.breakout.map((r) => <Row key={r.sku} r={r} up />)}</ul>
        </div>
      )}
    </div>
  );
}

// ── Inventory health ──
type InvHealth = { velocity: { fast: number; normal: number; slow: number; dead: number }; outOfStock: number; needsReorder: number; units: number; value: number };
export function InventoryHealthWidget({ data }: { data: Bundle }) {
  const d = g<InvHealth>(data, "inventoryHealth");
  if (!d) return null;
  const v = d.velocity;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2 text-center">
        <MiniStat label="On hand" value={num(d.units, true)} />
        <MiniStat label="Stock value" value={money(d.value, { compact: true })} />
        <MiniStat label="Out of stock" value={num(d.outOfStock)} tone={d.outOfStock > 0 ? "critical" : "good"} />
      </div>
      <div>
        <div className="mb-1 text-xs text-muted-foreground">Velocity mix</div>
        <HBars
          rows={[
            { label: "Fast (10+/wk)", value: v.fast ?? 0, color: STATUS.good },
            { label: "Normal (3–10)", value: v.normal ?? 0, color: seriesColor(0) },
            { label: "Slow (0.5–3)", value: v.slow ?? 0, color: STATUS.warn },
            { label: "Dead (<0.5)", value: v.dead ?? 0, color: STATUS.neutral },
          ]}
          format={(x) => `${num(x)}`}
        />
      </div>
    </div>
  );
}

// ── Reorder alerts ──
export function ReorderAlertsWidget({ data }: { data: Bundle }) {
  const rows = g<Array<{ sku: string; name: string; color: string; quantity: number; days_of_stock: number; velocity: number }>>(data, "reorderAlerts") ?? [];
  if (!rows.length) return <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">✅ Nothing needs reordering</div>;
  return (
    <ul className="divide-y">
      {rows.map((r) => {
        const oos = r.quantity <= 0;
        return (
          <li key={r.sku} className="flex items-center justify-between gap-2 py-2 text-sm">
            <div className="min-w-0">
              <div className="truncate font-medium">{r.name} <span className="text-muted-foreground">· {r.color}</span></div>
              <div className="text-xs text-muted-foreground">{r.sku} · {num(r.velocity ?? 0)}/wk</div>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: `${oos ? STATUS.critical : STATUS.serious}1a`, color: oos ? STATUS.critical : STATUS.serious }}>
              <AlertTriangle className="h-3 w-3" />
              {oos ? "Out" : `${num(r.quantity)} left`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ── Outreach ──
type Outreach = { calls: { total: number; connected: number; interested: number; priorConnected: number; priorTotal: number }; email: { sent: number; replies: number; interested: number } };
export function OutreachWidget({ data }: { data: Bundle }) {
  const d = g<Outreach>(data, "outreach");
  if (!d) return null;
  const connectRate = d.calls.total ? (d.calls.connected / d.calls.total) * 100 : 0;
  const replyRate = d.email.sent ? (d.email.replies / d.email.sent) * 100 : 0;
  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Phone className="h-3.5 w-3.5" /> Calls</div>
        <Meter value={connectRate} label="connect rate" color={seriesColor(0)} sub={`${num(d.calls.connected)} connected of ${num(d.calls.total)} dials · ${num(d.calls.interested)} interested`} />
      </div>
      <div>
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Mail className="h-3.5 w-3.5" /> Email</div>
        <Meter value={replyRate} label="reply rate" color={seriesColor(2)} sub={`${num(d.email.replies)} replies of ${num(d.email.sent)} sent · ${num(d.email.interested)} interested`} />
      </div>
    </div>
  );
}

// ── Meta leads ──
type MetaLeads = { total: number; processed: number; converted: number; byCampaign: Array<{ campaign: string; n: number }> };
export function MetaLeadsWidget({ data }: { data: Bundle }) {
  const d = g<MetaLeads>(data, "metaLeads");
  if (!d) return null;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2 text-center">
        <MiniStat label="New leads" value={num(d.total)} icon={<Facebook className="h-3.5 w-3.5" />} />
        <MiniStat label="Synced" value={num(d.processed)} />
        <MiniStat label="Converted" value={num(d.converted)} tone={d.converted > 0 ? "good" : "neutral"} />
      </div>
      {d.byCampaign.length > 0 && (
        <div>
          <div className="mb-1 text-xs text-muted-foreground">By campaign</div>
          <HBars rows={d.byCampaign.map((c, i) => ({ label: c.campaign, value: c.n, color: seriesColor(i % 6) }))} format={(v) => num(v)} />
        </div>
      )}
    </div>
  );
}

// ── Pipeline ──
type Pipeline = { byStage: Array<{ pipeline: string; stage: string; deals: number; value: number }>; totals: { open: number; won: number; lost: number; openValue: number } };
export function PipelineWidget({ data }: { data: Bundle }) {
  const d = g<Pipeline>(data, "pipeline");
  if (!d) return null;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2 text-center">
        <MiniStat label="Open" value={num(d.totals.open)} />
        <MiniStat label="Open value" value={money(d.totals.openValue, { compact: true })} />
        <MiniStat label="Won" value={num(d.totals.won)} tone="good" />
      </div>
      <HBars
        rows={d.byStage.slice(0, 7).map((s, i) => ({ label: `${s.stage}`, value: s.value || s.deals, sub: `${num(s.deals)} · ${s.pipeline}`, color: seriesColor(i % 6) }))}
        format={(v) => money(v, { compact: true })}
      />
    </div>
  );
}

// ── Customers ──
type Customers = { byStatus: Array<{ health_status: string; count: number; avg_score: number; total_ltv: number }>; byTier: Array<{ tier: string; count: number; total_ltv: number }> };
const HEALTH_TONE: Record<string, string> = { healthy: STATUS.good, at_risk: STATUS.warn, churning: STATUS.serious, churned: STATUS.critical };
export function CustomersWidget({ data }: { data: Bundle }) {
  const d = g<Customers>(data, "customers");
  if (!d) return null;
  const totalLtv = d.byStatus.reduce((a, s) => a + (s.total_ltv || 0), 0);
  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-semibold tabular-nums">{money(totalLtv, { compact: true })}</span>
        <span className="text-xs text-muted-foreground">total lifetime value</span>
      </div>
      <HBars
        rows={d.byStatus.map((s) => ({ label: (s.health_status || "unknown").replace("_", " "), value: s.count, sub: money(s.total_ltv, { compact: true }), color: HEALTH_TONE[s.health_status] ?? STATUS.neutral }))}
        format={(v) => num(v)}
      />
    </div>
  );
}

// ── Finance snapshot ──
type Finance = { revenue: number; cogs: number; grossMargin: number; grossMarginPct: number; netIncome: number; comparison?: { revenueChange: number } | null; error?: string };
export function FinanceWidget({ data }: { data: Bundle }) {
  const d = g<Finance>(data, "finance");
  if (!d || d.error) return <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">{d?.error ?? "No finance data"}</div>;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <MiniStat label="Revenue (MTD)" value={money(d.revenue, { compact: true })} />
        <MiniStat label="Net income" value={money(d.netIncome, { compact: true })} tone={d.netIncome >= 0 ? "good" : "critical"} />
      </div>
      <Meter value={d.grossMarginPct} label="gross margin" color={d.grossMarginPct >= 40 ? STATUS.good : STATUS.warn} sub={`${money(d.grossMargin, { compact: true })} on ${money(d.revenue, { compact: true })} · COGS ${money(d.cogs, { compact: true })}`} />
      {d.comparison && <div className="flex items-center gap-1 text-xs text-muted-foreground">Revenue vs prior period <Delta value={d.comparison.revenueChange} /></div>}
    </div>
  );
}

// ── Business health ──
type BizHealth = { overall: number; status: string; components: Record<string, { score: number; label: string; trend: string }>; error?: string };
export function BusinessHealthWidget({ data }: { data: Bundle }) {
  const d = g<BizHealth>(data, "businessHealth");
  if (!d || d.error) return <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">{d?.error ?? "No health data"}</div>;
  const tone = d.overall >= 75 ? STATUS.good : d.overall >= 50 ? STATUS.warn : STATUS.critical;
  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold tabular-nums" style={{ color: tone }}>{d.overall}</span>
        <span className="text-sm font-medium capitalize text-muted-foreground">{d.status}</span>
      </div>
      <div className="space-y-2">
        {Object.entries(d.components).map(([key, c]) => (
          <div key={key} className="space-y-1">
            <div className="flex justify-between text-xs"><span className="capitalize text-muted-foreground">{key}</span><span className="tabular-nums font-medium">{c.score}</span></div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full" style={{ width: `${c.score}%`, backgroundColor: c.score >= 75 ? STATUS.good : c.score >= 50 ? STATUS.warn : STATUS.critical }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Recent activity ──
export function ActivityWidget({ data }: { data: Bundle }) {
  const rows = g<Array<{ event_type: string; module: string; created_at: string }>>(data, "activity") ?? [];
  if (!rows.length) return <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">No recent activity</div>;
  return (
    <ul className="space-y-2">
      {rows.map((r, i) => (
        <li key={i} className="flex items-center gap-2 text-sm">
          <span className="rounded-md bg-muted p-1 text-muted-foreground"><ActivityIcon className="h-3 w-3" /></span>
          <span className="flex-1 truncate">{(r.event_type || "").replace(/[._]/g, " ")}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{relTime(r.created_at)}</span>
        </li>
      ))}
    </ul>
  );
}

// ── shared bits ──
function MiniStat({ label, value, tone, icon }: { label: string; value: string; tone?: keyof typeof STATUS; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-muted/40 px-2 py-1.5">
      <div className="flex items-center justify-center gap-1 text-base font-semibold tabular-nums" style={tone ? { color: STATUS[tone] } : undefined}>
        {icon}{value}
      </div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z").getTime();
  if (isNaN(ms)) return "";
  if (ms < 60000) return "now";
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h`;
  return `${Math.round(ms / 86400000)}d`;
}
