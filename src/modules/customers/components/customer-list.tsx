"use client";

import { useState, useMemo, useCallback } from "react";
import Link from "next/link";
import {
  CUSTOMER_TIERS,
  HEALTH_STATUSES,
  TIER_LABELS,
  TIER_COLORS,
  HEALTH_COLORS,
  type CustomerTier,
  type HealthStatus,
} from "@/modules/customers/schema";

interface CustomerRow {
  id: string;
  company_id: string;
  company_name: string;
  tier: CustomerTier;
  lifetime_value: number;
  total_orders: number;
  avg_order_value: number;
  health_score: number;
  health_status: HealthStatus;
  last_order_at: string | null;
  next_reorder_estimate: string | null;
  first_order_at: string | null;
}

type SortField = "lifetime_value" | "health_score" | "last_order_at" | "total_orders" | "days_until_reorder";

function daysUntilReorder(est: string | null): number | null {
  if (!est) return null;
  return Math.ceil((new Date(est).getTime() - Date.now()) / 86400000);
}

export function CustomerList({ customers }: { customers: CustomerRow[] }) {
  const [tierFilter, setTierFilter] = useState<CustomerTier | "all">("all");
  const [healthFilter, setHealthFilter] = useState<HealthStatus | "all">("all");
  const [sortBy, setSortBy] = useState<SortField>("lifetime_value");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [search, setSearch] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ created: number; updated: number } | null>(null);
  const [runningChurn, setRunningChurn] = useState(false);
  const [churnResult, setChurnResult] = useState<{ analyzed: number; newAlerts: number } | null>(null);
  const [runningReminders, setRunningReminders] = useState(false);
  const [reminderResult, setReminderResult] = useState<{ remindersCreated: number } | null>(null);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/v1/customers/sync", { method: "POST" });
      const data = await res.json();
      setSyncResult({ created: data.created, updated: data.updated });
      if (data.created > 0) window.location.reload();
    } catch (e) {
      console.error("Sync failed:", e);
    } finally {
      setSyncing(false);
    }
  }, []);

  const handleChurnAnalysis = useCallback(async () => {
    setRunningChurn(true);
    setChurnResult(null);
    try {
      const res = await fetch("/api/v1/customers/churn-analysis", { method: "POST" });
      const data = await res.json();
      setChurnResult({ analyzed: data.analyzed, newAlerts: data.newAlerts });
      if (data.updated > 0) window.location.reload();
    } catch (e) {
      console.error("Churn analysis failed:", e);
    } finally {
      setRunningChurn(false);
    }
  }, []);

  const handleGenerateReminders = useCallback(async () => {
    setRunningReminders(true);
    setReminderResult(null);
    try {
      const res = await fetch("/api/v1/customers/reorder-reminders", { method: "POST" });
      const data = await res.json();
      setReminderResult({ remindersCreated: data.remindersCreated });
    } catch (e) {
      console.error("Generate reminders failed:", e);
    } finally {
      setRunningReminders(false);
    }
  }, []);

  const filtered = useMemo(() => {
    let list = customers;
    if (tierFilter !== "all") list = list.filter((c) => c.tier === tierFilter);
    if (healthFilter !== "all") list = list.filter((c) => c.health_status === healthFilter);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((c) => c.company_name.toLowerCase().includes(q));
    }
    list = [...list].sort((a, b) => {
      if (sortBy === "days_until_reorder") {
        const av = daysUntilReorder(a.next_reorder_estimate) ?? 9999;
        const bv = daysUntilReorder(b.next_reorder_estimate) ?? 9999;
        return sortDir === "desc" ? bv - av : av - bv;
      }
      const av = a[sortBy] ?? 0;
      const bv = b[sortBy] ?? 0;
      return sortDir === "desc" ? (bv > av ? 1 : -1) : (av > bv ? 1 : -1);
    });
    return list;
  }, [customers, tierFilter, healthFilter, sortBy, sortDir, search]);

  const toggleSort = (field: SortField) => {
    if (sortBy === field) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortBy(field); setSortDir(field === "days_until_reorder" ? "asc" : "desc"); }
  };

  const formatCurrency = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  const formatDate = (d: string | null) => d ? new Date(d).toLocaleDateString() : "—";

  const stats = useMemo(() => ({
    total: customers.length,
    healthy: customers.filter((c) => c.health_status === "healthy").length,
    atRisk: customers.filter((c) => c.health_status === "at_risk").length,
    churning: customers.filter((c) => c.health_status === "churning" || c.health_status === "churned").length,
    totalLtv: customers.reduce((s, c) => s + c.lifetime_value, 0),
    approachingReorder: customers.filter((c) => {
      const d = daysUntilReorder(c.next_reorder_estimate);
      return d !== null && d <= 7;
    }).length,
  }), [customers]);

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
        <div className="rounded-lg border bg-white p-4">
          <p className="text-sm text-gray-500">Total Customers</p>
          <p className="text-2xl font-bold">{stats.total}</p>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <p className="text-sm text-gray-500">Healthy</p>
          <p className="text-2xl font-bold text-green-600">{stats.healthy}</p>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <p className="text-sm text-gray-500">At Risk</p>
          <p className="text-2xl font-bold text-yellow-600">{stats.atRisk}</p>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <p className="text-sm text-gray-500">Churning/Churned</p>
          <p className="text-2xl font-bold text-red-600">{stats.churning}</p>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <p className="text-sm text-gray-500">Total LTV</p>
          <p className="text-2xl font-bold">{formatCurrency(stats.totalLtv)}</p>
        </div>
        <div className="rounded-lg border bg-white p-4">
          <p className="text-sm text-gray-500">Reorder Soon</p>
          <p className="text-2xl font-bold text-orange-600">{stats.approachingReorder}</p>
        </div>
      </div>

      {/* Filters & Actions */}
      <div className="flex flex-wrap gap-3 items-center">
        <input
          type="text"
          placeholder="Search customers..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded-lg border px-3 py-2 text-sm w-64"
        />
        <select value={tierFilter} onChange={(e) => setTierFilter(e.target.value as any)} className="rounded-lg border px-3 py-2 text-sm">
          <option value="all">All Tiers</option>
          {CUSTOMER_TIERS.map((t) => <option key={t} value={t}>{TIER_LABELS[t]}</option>)}
        </select>
        <select value={healthFilter} onChange={(e) => setHealthFilter(e.target.value as any)} className="rounded-lg border px-3 py-2 text-sm">
          <option value="all">All Health</option>
          {HEALTH_STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())}</option>)}
        </select>
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          {syncResult && (
            <span className="text-xs text-green-600">{syncResult.created} created, {syncResult.updated} updated</span>
          )}
          {churnResult && (
            <span className="text-xs text-blue-600">{churnResult.analyzed} analyzed, {churnResult.newAlerts} new alerts</span>
          )}
          {reminderResult && (
            <span className="text-xs text-orange-600">{reminderResult.remindersCreated} reminders created</span>
          )}
          <button
            onClick={handleGenerateReminders}
            disabled={runningReminders}
            className="inline-flex items-center gap-2 rounded-lg bg-orange-500 px-3 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50"
          >
            {runningReminders ? (
              <>
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                Generating...
              </>
            ) : "Generate Reminders"}
          </button>
          <button
            onClick={handleChurnAnalysis}
            disabled={runningChurn}
            className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {runningChurn ? (
              <>
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                Analyzing...
              </>
            ) : "Run Churn Analysis"}
          </button>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {syncing ? (
              <>
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                Syncing...
              </>
            ) : "Sync Accounts"}
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-4 py-3">Company</th>
              <th className="px-4 py-3">Tier</th>
              <th className="px-4 py-3 cursor-pointer" onClick={() => toggleSort("lifetime_value")}>
                LTV {sortBy === "lifetime_value" ? (sortDir === "desc" ? "↓" : "↑") : ""}
              </th>
              <th className="px-4 py-3 cursor-pointer" onClick={() => toggleSort("total_orders")}>
                Orders {sortBy === "total_orders" ? (sortDir === "desc" ? "↓" : "↑") : ""}
              </th>
              <th className="px-4 py-3 cursor-pointer" onClick={() => toggleSort("health_score")}>
                Health {sortBy === "health_score" ? (sortDir === "desc" ? "↓" : "↑") : ""}
              </th>
              <th className="px-4 py-3 cursor-pointer" onClick={() => toggleSort("last_order_at")}>
                Last Order {sortBy === "last_order_at" ? (sortDir === "desc" ? "↓" : "↑") : ""}
              </th>
              <th className="px-4 py-3 cursor-pointer" onClick={() => toggleSort("days_until_reorder")}>
                Reorder In {sortBy === "days_until_reorder" ? (sortDir === "desc" ? "↓" : "↑") : ""}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.map((c) => {
              const days = daysUntilReorder(c.next_reorder_estimate);
              return (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link href={`/customers/${c.id}`} className="font-medium text-blue-600 hover:underline">
                      {c.company_name}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${TIER_COLORS[c.tier]}`}>
                      {TIER_LABELS[c.tier]}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium">{formatCurrency(c.lifetime_value)}</td>
                  <td className="px-4 py-3">{c.total_orders}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${HEALTH_COLORS[c.health_status]}`}>
                      {c.health_status === "churned" ? "⚫" : c.health_status === "churning" ? "🔴" : c.health_status === "at_risk" ? "🟡" : "🟢"}{" "}
                      {c.health_score} — {c.health_status.replace("_", " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(c.last_order_at)}</td>
                  <td className="px-4 py-3">
                    {days !== null ? (
                      <span className={`font-medium ${days < 0 ? "text-red-600" : days <= 7 ? "text-yellow-600" : "text-gray-500"}`}>
                        {days < 0 ? `${Math.abs(days)}d overdue` : `${days}d`}
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-16 text-center">
                <svg className="h-10 w-10 mx-auto text-gray-300 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                <p className="font-medium text-gray-500">No customers found</p>
                <p className="text-sm text-gray-400 mt-1">Sync accounts from orders to populate your customer list.</p>
                <button onClick={handleSync} disabled={syncing} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                  {syncing ? "Syncing..." : "Sync Accounts"}
                </button>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
