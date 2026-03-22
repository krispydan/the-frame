"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useBreadcrumbOverride } from "@/components/layout/breadcrumb-context";
import { TIER_LABELS, TIER_COLORS, HEALTH_COLORS, type CustomerTier, type HealthStatus } from "@/modules/customers/schema";

interface AccountData {
  id: string;
  company_name: string;
  company_email: string | null;
  company_phone: string | null;
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
  activities,
  healthHistory,
  reorderPrediction,
  churnRisk,
}: {
  account: AccountData;
  recentOrders: OrderRow[];
  activities: ActivityRow[];
  healthHistory: HealthHistoryRow[];
  reorderPrediction?: ReorderPrediction | null;
  churnRisk?: ChurnRiskData | null;
}) {
  const { setOverride } = useBreadcrumbOverride();
  useEffect(() => {
    if (account.company_name) setOverride(account.company_name);
    return () => setOverride(null);
  }, [account.company_name, setOverride]);

  const daysUntilReorder = account.next_reorder_estimate
    ? Math.ceil((new Date(account.next_reorder_estimate).getTime() - Date.now()) / 86400000)
    : null;

  const retentionInfo = RETENTION_ACTIONS[account.health_status] || RETENTION_ACTIONS.healthy;
  const isAtRisk = account.health_status !== "healthy";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <Link href="/customers" className="text-gray-400 hover:text-gray-600">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            </Link>
            <h1 className="text-2xl font-bold">{account.company_name}</h1>
          </div>
          <div className="flex flex-wrap gap-2 mt-1 ml-8">
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${TIER_COLORS[account.tier]}`}>
              {TIER_LABELS[account.tier]}
            </span>
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
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="rounded-lg border bg-white p-4">
          <p className="text-sm text-gray-500">Lifetime Value</p>
          <p className="text-xl font-bold">{formatCurrency(account.lifetime_value)}</p>
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

      {/* Account Details */}
      {(account.payment_terms || account.discount_rate > 0 || account.notes) && (
        <div className="rounded-lg border bg-white p-4 space-y-2">
          <h2 className="font-semibold">Account Details</h2>
          {account.payment_terms && <p className="text-sm"><span className="text-gray-500">Payment Terms:</span> {account.payment_terms}</p>}
          {account.discount_rate > 0 && <p className="text-sm"><span className="text-gray-500">Discount:</span> {account.discount_rate}%</p>}
          {account.notes && <p className="text-sm text-gray-600">{account.notes}</p>}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        {/* Order History */}
        <div className="rounded-lg border bg-white p-4">
          <h2 className="font-semibold mb-3">Order History</h2>
          {recentOrders.length === 0 ? (
            <p className="text-gray-400 text-sm">No orders yet</p>
          ) : (
            <div className="space-y-2">
              {recentOrders.map((o) => (
                <div key={o.id} className="flex justify-between items-center py-2 border-b last:border-0">
                  <div>
                    <p className="font-medium text-sm">{o.order_number}</p>
                    <p className="text-xs text-gray-500">{o.channel} · {formatDate(o.placed_at)}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-medium text-sm">{formatCurrency(o.total)}</p>
                    <p className="text-xs text-gray-500">{o.status}</p>
                  </div>
                </div>
              ))}
            </div>
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
