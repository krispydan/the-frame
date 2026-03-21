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

type SortField = "lifetime_value" | "health_score" | "last_order_at" | "total_orders";

export function CustomerList({ customers }: { customers: CustomerRow[] }) {
  const [tierFilter, setTierFilter] = useState<CustomerTier | "all">("all");
  const [healthFilter, setHealthFilter] = useState<HealthStatus | "all">("all");
  const [sortBy, setSortBy] = useState<SortField>("lifetime_value");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [search, setSearch] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ created: number; updated: number } | null>(null);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/v1/customers/sync", { method: "POST" });
      const data = await res.json();
      setSyncResult({ created: data.created, updated: data.updated });
      // Reload to show new accounts
      if (data.created > 0) window.location.reload();
    } catch (e) {
      console.error("Sync failed:", e);
    } finally {
      setSyncing(false);
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
      const av = a[sortBy] ?? 0;
      const bv = b[sortBy] ?? 0;
      return sortDir === "desc" ? (bv > av ? 1 : -1) : (av > bv ? 1 : -1);
    });
    return list;
  }, [customers, tierFilter, healthFilter, sortBy, sortDir, search]);

  const toggleSort = (field: SortField) => {
    if (sortBy === field) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortBy(field); setSortDir("desc"); }
  };

  const formatCurrency = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  const formatDate = (d: string | null) => d ? new Date(d).toLocaleDateString() : "—";

  const stats = useMemo(() => ({
    total: customers.length,
    healthy: customers.filter((c) => c.health_status === "healthy").length,
    atRisk: customers.filter((c) => c.health_status === "at_risk").length,
    totalLtv: customers.reduce((s, c) => s + c.lifetime_value, 0),
  }), [customers]);

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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
          <p className="text-sm text-gray-500">Total LTV</p>
          <p className="text-2xl font-bold">{formatCurrency(stats.totalLtv)}</p>
        </div>
      </div>

      {/* Filters */}
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
        <div className="ml-auto flex items-center gap-2">
          {syncResult && (
            <span className="text-xs text-green-600">
              {syncResult.created} created, {syncResult.updated} updated
            </span>
          )}
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
            ) : (
              "Sync Accounts"
            )}
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
              <th className="px-4 py-3">Next Reorder</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.map((c) => (
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
                    {c.health_score} — {c.health_status.replace("_", " ")}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500">{formatDate(c.last_order_at)}</td>
                <td className="px-4 py-3 text-gray-500">{formatDate(c.next_reorder_estimate)}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">No customers found</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
