"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useBreadcrumbOverride } from "@/components/layout/breadcrumb-context";
import { TIER_LABELS, TIER_COLORS, HEALTH_COLORS, type CustomerTier, type HealthStatus } from "@/modules/customers/schema";
import { PipedrivePanel } from "@/modules/sales/components/pipedrive-panel";
import { GmapsPanel } from "@/modules/sales/components/gmaps-panel";
import { EmailPanel } from "@/modules/email/components/email-panel";

interface AccountData {
  id: string;
  company_id: string;
  company_name: string;
  company_email: string | null;
  company_phone: string | null;
  segment: string | null;
  tier: CustomerTier;
  lifetime_value: number;
  total_orders: number;
  avg_order_value: number;
  health_score: number;
  health_status: HealthStatus;
  first_order_at: string | null;
  last_order_at: string | null;
  next_reorder_estimate: string | null;
  payment_terms: string | null;
  discount_rate: number;
  notes: string | null;
}

interface ChurnRiskData {
  healthScore: number;
  healthStatus: string;
  riskFactors: string[];
  recommendation: string;
  daysSinceLastOrder: number | null;
}

interface ReorderPrediction {
  accountId: string;
  companyName: string;
  avgDaysBetweenOrders: number | null;
  lastOrderAt: string | null;
  predictedReorderDate: string | null;
  daysUntilReorder: number | null;
  reminderStatus: "none" | "14_day" | "7_day" | "overdue";
  totalOrders: number;
}

interface OrderRow {
  id: string;
  order_number: string;
  channel: string;
  status: string;
  total: number;
  placed_at: string;
}

/** Per-order economics from order-economics.ts (3PL actual OR estimated). */
interface OrderEconomicsData {
  revenue: number;
  shippingCharged: number;
  cogs: number | null;
  cogsComplete: boolean;
  threePl: { basis: "actual" | "estimated" | "none"; fulfillment: number; postage: number; other: number; total: number };
  netProfit: number | null;
  netMarginPct: number | null;
}

type OrderWithEconomics = OrderRow & { economics: OrderEconomicsData | null };

interface BenchmarkMetric { value: number; percentile: number; avg: number }
interface Benchmarks { base: number; ltv: BenchmarkMetric; aov: BenchmarkMetric; orders: BenchmarkMetric }

/** AJ Morgan (acquired brand) purchase history for this company. */
interface AjmHistory {
  orders: number;
  units: number | null;
  revenue: number | null;
  firstOrder: string | null;
  lastOrder: string | null;
  sources: string | null;
  orderRows: Array<{ id: string; source: string; order_number: string; order_date: string | null; total: number; units: number; status: string | null }>;
  topProducts: Array<{ product: string; units: number; revenue: number }>;
}

interface ActivityRow {
  id: string;
  type: string;
  description: string | null;
  created_at: string;
}

interface HealthHistoryRow {
  score: number;
  status: string;
  factors: string | null;
  calculated_at: string;
}

const formatCurrency = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const formatDate = (d: string | null) => d ? new Date(d).toLocaleDateString() : "—";

const RETENTION_ACTIONS: Record<string, { icon: string; actions: string[] }> = {
  churned: {
    icon: "⚫",
    actions: [
      "Launch win-back campaign with incentive (15-20% discount)",
      "Personal call from account manager to understand why they left",
      "Send product updates highlighting new features since their last order",
      "Offer free samples of new collection",
    ],
  },
  churning: {
    icon: "🔴",
    actions: [
      "Immediate personal outreach — call or email within 24h",
      "Understand blockers: product issues, pricing, competition?",
      "Offer tailored reorder package with volume discount",
      "Schedule quarterly business review to re-engage",
    ],
  },
  at_risk: {
    icon: "🟡",
    actions: [
      "Send reorder reminder with special seasonal offer",
      "Share bestseller data and trend insights for their market",
      "Offer early access to upcoming collection",
      "Check if payment terms need adjustment",
    ],
  },
  healthy: {
    icon: "🟢",
    actions: [],
  },
};

export function CustomerDetail({
  account,
  recentOrders,
  orderEconomics,
  benchmarks,
  ajmHistory,
  activities,
  healthHistory,
  reorderPrediction,
  churnRisk,
}: {
  account: AccountData;
  recentOrders: OrderRow[];
  orderEconomics?: OrderWithEconomics[];
  benchmarks?: Benchmarks | null;
  ajmHistory?: AjmHistory | null;
  activities: ActivityRow[];
  healthHistory: HealthHistoryRow[];
  reorderPrediction?: ReorderPrediction | null;
  churnRisk?: ChurnRiskData | null;
}) {
  const { setOverride } = useBreadcrumbOverride();
  const searchParams = useSearchParams();
  const [renderNow] = useState(() => Date.now());
  useEffect(() => {
    if (account.company_name) setOverride(account.company_name);
    return () => setOverride(null);
  }, [account.company_name, setOverride]);

  const daysUntilReorder = account.next_reorder_estimate
    ? Math.ceil((new Date(account.next_reorder_estimate).getTime() - renderNow) / 86400000)
    : null;
  const backHref = searchParams.toString() ? `/customers?${searchParams.toString()}` : "/customers";

  const retentionInfo = RETENTION_ACTIONS[account.health_status] || RETENTION_ACTIONS.healthy;
  const isAtRisk = account.health_status !== "healthy";

  // ── Profit rollup (3PL costs actual or estimated, never mixed per order) ──
  const econRows = (orderEconomics ?? []).filter((r) => r.economics && r.status !== "cancelled");
  const lifetimeProfit = econRows.reduce((s, r) => s + (r.economics!.netProfit ?? 0), 0);
  const profitKnownCount = econRows.filter((r) => r.economics!.netProfit != null).length;
  const anyEstimated = econRows.some((r) => r.economics!.threePl.basis === "estimated");
  const lifetimeMarginPct = account.lifetime_value > 0 && profitKnownCount > 0
    ? (lifetimeProfit / account.lifetime_value) * 100
    : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <Link href={backHref} className="text-gray-400 hover:text-gray-600">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            </Link>
            <h1 className="text-2xl font-bold">{account.company_name}</h1>
          </div>
          <div className="flex flex-wrap gap-2 mt-1 ml-8">
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${TIER_COLORS[account.tier]}`}>
              {TIER_LABELS[account.tier]}
            </span>
            {account.segment && (
              <Link
                href={`/customers?segment=${encodeURIComponent(account.segment)}`}
                className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-200"
              >
                {account.segment}
              </Link>
            )}
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${HEALTH_COLORS[account.health_status]}`}>
              {retentionInfo.icon} {account.health_score} — {account.health_status.replace("_", " ")}
            </span>
            {account.company_email && (
              <span className="text-xs text-gray-500">✉ {account.company_email}</span>
            )}
            {account.company_phone && (
              <span className="text-xs text-gray-500">☎ {account.company_phone}</span>
            )}
          </div>
        </div>
      </div>

      {/* Churn Risk Alert */}
      {isAtRisk && (
        <div className={`rounded-lg border-l-4 p-4 ${
          account.health_status === "churned" ? "border-gray-800 bg-gray-50" :
          account.health_status === "churning" ? "border-red-500 bg-red-50" :
          "border-yellow-500 bg-yellow-50"
        }`}>
          <div className="flex items-start gap-3">
            <span className="text-2xl">{retentionInfo.icon}</span>
            <div className="flex-1">
              <h3 className="font-semibold text-sm">
                {account.health_status === "churned" ? "Churned Account" :
                 account.health_status === "churning" ? "High Churn Risk" :
                 "At Risk — Action Needed"}
              </h3>
              {churnRisk && churnRisk.riskFactors.length > 0 && (
                <div className="mt-1">
                  <p className="text-sm text-gray-600">Risk factors:</p>
                  <ul className="list-disc list-inside text-sm text-gray-700 mt-1">
                    {churnRisk.riskFactors.map((f, i) => <li key={i}>{f}</li>)}
                  </ul>
                </div>
              )}
              {churnRisk?.recommendation && (
                <p className="text-sm font-medium mt-2">💡 {churnRisk.recommendation}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Retention Actions */}
      {isAtRisk && retentionInfo.actions.length > 0 && (
        <div className="rounded-lg border bg-white p-4">
          <h2 className="font-semibold mb-3">🎯 Suggested Retention Actions</h2>
          <div className="grid md:grid-cols-2 gap-2">
            {retentionInfo.actions.map((action, i) => (
              <div key={i} className="flex items-start gap-2 p-2 rounded bg-gray-50">
                <span className="text-sm font-bold text-gray-400">{i + 1}.</span>
                <p className="text-sm">{action}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Overview Cards */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
        <div className="rounded-lg border bg-white p-4">
          <p className="text-sm text-gray-500">Lifetime Value</p>
          <p className="text-xl font-bold">{formatCurrency(account.lifetime_value)}</p>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <p className="text-sm text-gray-500">Lifetime Profit{anyEstimated ? " (est.)" : ""}</p>
          <p className={`text-xl font-bold ${lifetimeProfit >= 0 ? "text-green-600" : "text-red-600"}`}>
            {profitKnownCount > 0 ? formatCurrency(lifetimeProfit) : "—"}
          </p>
          {lifetimeMarginPct != null && (
            <p className="text-xs text-gray-500">{lifetimeMarginPct.toFixed(0)}% of revenue</p>
          )}
        </div>
        <div className="rounded-lg border bg-white p-4">
          <p className="text-sm text-gray-500">Total Orders</p>
          <p className="text-xl font-bold">{account.total_orders}</p>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <p className="text-sm text-gray-500">Avg Order</p>
          <p className="text-xl font-bold">{formatCurrency(account.avg_order_value)}</p>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <p className="text-sm text-gray-500">First Order</p>
          <p className="text-xl font-bold">{formatDate(account.first_order_at)}</p>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <p className="text-sm text-gray-500">Next Reorder</p>
          <p className={`text-xl font-bold ${daysUntilReorder !== null && daysUntilReorder < 0 ? "text-red-600" : daysUntilReorder !== null && daysUntilReorder <= 7 ? "text-yellow-600" : ""}`}>
            {daysUntilReorder !== null ? (daysUntilReorder < 0 ? `${Math.abs(daysUntilReorder)}d overdue` : `${daysUntilReorder}d`) : "—"}
          </p>
        </div>
      </div>

      {/* ── Benchmarks: how this customer compares to the whole base ── */}
      {benchmarks && benchmarks.base > 1 && (
        <div className="rounded-lg border bg-white p-4">
          <h2 className="font-semibold mb-1">📊 How they compare</h2>
          <p className="text-xs text-gray-500 mb-3">vs all {benchmarks.base.toLocaleString()} customers — higher percentile is better</p>
          <div className="grid md:grid-cols-3 gap-4">
            {([
              { label: "Lifetime Value", m: benchmarks.ltv, fmt: (v: number) => formatCurrency(v) },
              { label: "Avg Order Value", m: benchmarks.aov, fmt: (v: number) => formatCurrency(v) },
              { label: "Order Count", m: benchmarks.orders, fmt: (v: number) => v.toFixed(v % 1 ? 1 : 0) },
            ] as const).map(({ label, m, fmt }) => {
              const topPct = Math.max(1, 100 - m.percentile);
              const good = m.percentile >= 75;
              const mid = m.percentile >= 40 && m.percentile < 75;
              return (
                <div key={label}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="text-gray-500">{label}</span>
                    <span className={`text-xs font-semibold ${good ? "text-green-600" : mid ? "text-yellow-600" : "text-red-600"}`}>
                      {good ? `Top ${topPct}%` : `${m.percentile}th percentile`}
                    </span>
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${good ? "bg-green-500" : mid ? "bg-yellow-500" : "bg-red-400"}`}
                      style={{ width: `${Math.max(3, m.percentile)}%` }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    {fmt(m.value)} vs {fmt(m.avg)} avg
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Profit by order: what we actually made on each order ── */}
      {econRows.length > 0 && (
        <div className="rounded-lg border bg-white p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Profit by Order</h2>
            {anyEstimated && (
              <span className="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded" title="Orders not yet on an imported Big Sky invoice use rate-card + typical-postage estimates. Actual and estimated are never mixed within an order.">
                est. = awaiting 3PL invoice
              </span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b">
                  <th className="py-1.5 pr-2">Order</th>
                  <th className="py-1.5 pr-2">Date</th>
                  <th className="py-1.5 pr-2 text-right">Revenue</th>
                  <th className="py-1.5 pr-2 text-right">COGS</th>
                  <th className="py-1.5 pr-2 text-right">3PL cost</th>
                  <th className="py-1.5 pr-2 text-right">Net profit</th>
                  <th className="py-1.5 text-right">Margin</th>
                </tr>
              </thead>
              <tbody>
                {econRows.map((r) => {
                  const e = r.economics!;
                  const est = e.threePl.basis === "estimated";
                  return (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-1.5 pr-2">
                        <Link href={`/orders/${r.id}`} className="font-medium hover:underline">{r.order_number}</Link>
                        <span className="ml-1.5 text-xs text-gray-400">{r.channel.replace("shopify_", "")}</span>
                      </td>
                      <td className="py-1.5 pr-2 text-gray-500">{formatDate(r.placed_at)}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{formatCurrency(e.revenue)}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{e.cogs != null ? formatCurrency(e.cogs) : <span className="text-amber-600 text-xs">n/a</span>}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">
                        {formatCurrency(e.threePl.total)}
                        {est && <span className="ml-1 text-[10px] text-amber-600 align-top">est</span>}
                      </td>
                      <td className={`py-1.5 pr-2 text-right tabular-nums font-medium ${e.netProfit == null ? "text-gray-400" : e.netProfit >= 0 ? "text-green-600" : "text-red-600"}`}>
                        {e.netProfit != null ? formatCurrency(e.netProfit) : "—"}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-gray-600">
                        {e.netMarginPct != null ? `${e.netMarginPct.toFixed(0)}%` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td className="py-2 pr-2" colSpan={2}>Total ({econRows.length} orders)</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{formatCurrency(econRows.reduce((s, r) => s + r.economics!.revenue, 0))}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{formatCurrency(econRows.reduce((s, r) => s + (r.economics!.cogs ?? 0), 0))}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{formatCurrency(econRows.reduce((s, r) => s + r.economics!.threePl.total, 0))}</td>
                  <td className={`py-2 pr-2 text-right tabular-nums ${lifetimeProfit >= 0 ? "text-green-600" : "text-red-600"}`}>{formatCurrency(lifetimeProfit)}</td>
                  <td className="py-2 text-right tabular-nums">{lifetimeMarginPct != null ? `${lifetimeMarginPct.toFixed(0)}%` : "—"}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ── AJ Morgan history: what this customer bought from the acquired
          brand — context for win-backs and share-of-wallet conversations. ── */}
      {ajmHistory && (
        <div className="rounded-lg border bg-white p-4">
          <div className="flex items-center justify-between mb-1">
            <h2 className="font-semibold">🏛️ AJ Morgan History</h2>
            <Link href="/customers/ajm" className="text-xs text-blue-600 hover:underline">all AJM customers →</Link>
          </div>
          <p className="text-sm text-gray-600 mb-3">
            Bought <span className="font-semibold">{formatCurrency(ajmHistory.revenue ?? 0)}</span> across{" "}
            <span className="font-semibold">{ajmHistory.orders} orders</span> ({(ajmHistory.units ?? 0).toLocaleString()} units)
            from AJ Morgan, {ajmHistory.firstOrder?.slice(0, 7)} – {ajmHistory.lastOrder?.slice(0, 7)}
            {ajmHistory.sources ? ` · via ${ajmHistory.sources.split(",").map((s) => s.replace("shopify_", "")).join(", ")}` : ""}.
            {account.lifetime_value > 0
              ? ` With Jaxy so far: ${formatCurrency(account.lifetime_value)}.`
              : " No Jaxy orders yet — win-back candidate."}
          </p>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1">Top AJM products</p>
              <div className="space-y-0.5">
                {ajmHistory.topProducts.map((p) => (
                  <div key={p.product} className="flex justify-between text-sm">
                    <span className="truncate mr-2">{p.product}</span>
                    <span className="tabular-nums text-gray-600 whitespace-nowrap">{p.units.toLocaleString()}u · {formatCurrency(p.revenue)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1">AJM orders (latest {Math.min(ajmHistory.orderRows.length, 100)})</p>
              <div className="max-h-48 overflow-y-auto space-y-0.5 pr-1">
                {ajmHistory.orderRows.map((o) => (
                  <div key={o.id} className="flex justify-between text-sm py-0.5 border-b last:border-0">
                    <span>
                      <span className="font-medium">{o.order_number}</span>
                      <span className="ml-1.5 text-xs text-gray-400">{o.source.replace("shopify_", "")} · {o.order_date ?? "—"}</span>
                    </span>
                    <span className="tabular-nums">{formatCurrency(o.total)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Account Details */}
      {(account.segment || account.payment_terms || account.discount_rate > 0 || account.notes) && (
        <div className="rounded-lg border bg-white p-4 space-y-2">
          <h2 className="font-semibold">Account Details</h2>
          {account.segment && (
            <p className="text-sm">
              <span className="text-gray-500">Segment:</span>{" "}
              <Link href={`/customers?segment=${encodeURIComponent(account.segment)}`} className="hover:text-blue-600 hover:underline">
                {account.segment}
              </Link>
            </p>
          )}
          {account.payment_terms && <p className="text-sm"><span className="text-gray-500">Payment Terms:</span> {account.payment_terms}</p>}
          {account.discount_rate > 0 && <p className="text-sm"><span className="text-gray-500">Discount:</span> {account.discount_rate}%</p>}
          {account.notes && <p className="text-sm text-gray-600">{account.notes}</p>}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        {/* Revenue vs profit per order, oldest → newest. The detailed rows
            live in the Profit by Order table above; this is the shape-of-the-
            relationship view for the sales team. */}
        <div className="rounded-lg border bg-white p-4">
          <h2 className="font-semibold mb-3">Revenue &amp; Profit per Order</h2>
          {econRows.length === 0 ? (
            <p className="text-gray-400 text-sm">No orders yet</p>
          ) : (
            (() => {
              const chartRows = [...econRows].reverse().slice(-20);
              const maxRev = Math.max(1, ...chartRows.map((r) => r.economics!.revenue));
              return (
                <>
                  <div className="flex items-end gap-1 h-36">
                    {chartRows.map((r) => {
                      const e = r.economics!;
                      const revH = Math.max(3, (e.revenue / maxRev) * 100);
                      const profH = e.netProfit != null && e.netProfit > 0 ? (e.netProfit / maxRev) * 100 : 0;
                      const loss = e.netProfit != null && e.netProfit < 0;
                      return (
                        <Link
                          key={r.id}
                          href={`/orders/${r.id}`}
                          className="group relative flex-1 flex flex-col justify-end h-full"
                          title={`${r.order_number} · ${formatDate(r.placed_at)}\nRevenue ${formatCurrency(e.revenue)} · Profit ${e.netProfit != null ? formatCurrency(e.netProfit) : "n/a"}${e.threePl.basis === "estimated" ? " (est.)" : ""}`}
                        >
                          <div className={`w-full rounded-t ${loss ? "bg-red-200" : "bg-blue-100"} group-hover:opacity-80 relative`} style={{ height: `${revH}%` }}>
                            {profH > 0 && (
                              <div className="absolute bottom-0 left-0 right-0 rounded-t bg-green-500/80" style={{ height: `${Math.min(100, (profH / revH) * 100)}%` }} />
                            )}
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                    <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-blue-100" /> Revenue</span>
                    <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-green-500/80" /> Net profit</span>
                    <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-red-200" /> Loss-making</span>
                    <span className="ml-auto">last {chartRows.length} orders, oldest → newest</span>
                  </div>
                </>
              );
            })()
          )}
        </div>

        {/* Activity Timeline */}
        <div className="rounded-lg border bg-white p-4">
          <h2 className="font-semibold mb-3">Activity Timeline</h2>
          {activities.length === 0 ? (
            <p className="text-gray-400 text-sm">No activity yet</p>
          ) : (
            <div className="space-y-2">
              {activities.map((a) => (
                <div key={a.id} className="py-2 border-b last:border-0">
                  <div className="flex justify-between">
                    <span className="text-xs font-medium uppercase text-gray-500">{a.type}</span>
                    <span className="text-xs text-gray-400">{formatDate(a.created_at)}</span>
                  </div>
                  {a.description && <p className="text-sm text-gray-700 mt-1">{a.description}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Pipedrive — live CRM record (keyed by the underlying company id) */}
      <PipedrivePanel companyId={account.company_id} companyName={account.company_name} />

      {/* What Google says the store actually is — captured on conversion */}
      <GmapsPanel companyId={account.company_id} />

      {/* Gmail correspondence + composer */}
      <EmailPanel companyId={account.company_id} defaultTo={account.company_email} />

      {/* Reorder Prediction */}
      {reorderPrediction && reorderPrediction.avgDaysBetweenOrders && (
        <div className="rounded-lg border bg-white p-4">
          <h2 className="font-semibold mb-3">Reorder Prediction</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-sm text-gray-500">Avg Days Between Orders</p>
              <p className="text-lg font-bold">{reorderPrediction.avgDaysBetweenOrders}d</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Predicted Reorder</p>
              <p className="text-lg font-bold">{reorderPrediction.predictedReorderDate ? formatDate(reorderPrediction.predictedReorderDate) : "—"}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Days Until Reorder</p>
              <p className={`text-lg font-bold ${
                reorderPrediction.daysUntilReorder !== null && reorderPrediction.daysUntilReorder < 0
                  ? "text-red-600"
                  : reorderPrediction.daysUntilReorder !== null && reorderPrediction.daysUntilReorder <= 7
                  ? "text-yellow-600"
                  : ""
              }`}>
                {reorderPrediction.daysUntilReorder !== null
                  ? reorderPrediction.daysUntilReorder < 0
                    ? `${Math.abs(reorderPrediction.daysUntilReorder)}d overdue`
                    : `${reorderPrediction.daysUntilReorder}d`
                  : "—"}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Status</p>
              <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                reorderPrediction.reminderStatus === "overdue"
                  ? "bg-red-100 text-red-800"
                  : reorderPrediction.reminderStatus === "7_day"
                  ? "bg-yellow-100 text-yellow-800"
                  : reorderPrediction.reminderStatus === "14_day"
                  ? "bg-blue-100 text-blue-800"
                  : "bg-gray-100 text-gray-600"
              }`}>
                {reorderPrediction.reminderStatus === "none" ? "On Track" : reorderPrediction.reminderStatus.replace("_", " ")}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Health History Chart (simplified table) */}
      {healthHistory.length > 0 && (
        <div className="rounded-lg border bg-white p-4">
          <h2 className="font-semibold mb-3">Health Score History</h2>
          <div className="flex gap-4 overflow-x-auto">
            {healthHistory.map((h, i) => (
              <div key={i} className="flex-shrink-0 text-center">
                <div className="text-2xl font-bold">{h.score}</div>
                <div className={`text-xs rounded-full px-2 py-0.5 ${HEALTH_COLORS[h.status as keyof typeof HEALTH_COLORS] || ""}`}>
                  {h.status.replace("_", " ")}
                </div>
                <div className="text-xs text-gray-400 mt-1">{formatDate(h.calculated_at)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
