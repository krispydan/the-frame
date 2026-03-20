"use client";

import { Suspense, useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

interface Prospect {
  id: string;
  name: string;
  city: string;
  state: string;
  type: string;
  source: string;
  phone: string;
  email: string;
  icp_score: number | null;
  status: string;
  tags: string[];
  website: string;
  domain: string;
}

interface FilterOptions {
  states: { state: string; count: number }[];
  statuses: { status: string; count: number }[];
  sources: { source: string; count: number }[];
  categories: { category: string; count: number }[];
  icpRange: { min: number; max: number };
}

interface ApiResponse {
  data: Prospect[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export default function ProspectsPageWrapper() {
  return (
    <Suspense fallback={<div className="p-6 text-gray-400">Loading prospects...</div>}>
      <ProspectsPage />
    </Suspense>
  );
}

function ProspectsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  // Current params
  const page = parseInt(searchParams.get("page") || "1");
  const limit = 25;
  const search = searchParams.get("search") || "";
  const sort = searchParams.get("sort") || "name";
  const order = searchParams.get("order") || "asc";
  const stateFilter = searchParams.getAll("state");
  const categoryFilter = searchParams.getAll("category");
  const sourceFilter = searchParams.getAll("source");
  const statusFilter = searchParams.getAll("status");
  const hasEmail = searchParams.get("has_email");
  const hasPhone = searchParams.get("has_phone");
  const icpMin = searchParams.get("icp_min");
  const icpMax = searchParams.get("icp_max");

  // Selection state
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectAll, setSelectAll] = useState(false);
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [bulkLoading, setBulkLoading] = useState(false);

  // Search debounce
  const [searchInput, setSearchInput] = useState(search);

  // Active filter count
  const activeFilterCount = stateFilter.length + categoryFilter.length + sourceFilter.length + statusFilter.length 
    + (hasEmail ? 1 : 0) + (hasPhone ? 1 : 0) + (icpMin ? 1 : 0) + (icpMax ? 1 : 0);

  const buildUrl = useCallback((overrides: Record<string, string | string[] | null>) => {
    const p = new URLSearchParams();
    const vals: Record<string, string | string[] | null> = {
      page: String(page),
      search,
      sort,
      order,
      state: stateFilter,
      category: categoryFilter,
      source: sourceFilter,
      status: statusFilter,
      has_email: hasEmail,
      has_phone: hasPhone,
      icp_min: icpMin,
      icp_max: icpMax,
      ...overrides,
    };

    for (const [k, v] of Object.entries(vals)) {
      if (v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
      if (Array.isArray(v)) {
        v.forEach(val => p.append(k, val));
      } else {
        p.set(k, v);
      }
    }
    return `/prospects?${p.toString()}`;
  }, [page, search, sort, order, stateFilter, categoryFilter, sourceFilter, statusFilter, hasEmail, hasPhone, icpMin, icpMax]);

  // Fetch data
  useEffect(() => {
    setLoading(true);
    const apiParams = new URLSearchParams(searchParams.toString());
    apiParams.set("limit", String(limit));
    if (!apiParams.has("page")) apiParams.set("page", "1");

    fetch(`/api/v1/sales/prospects?${apiParams.toString()}`)
      .then(r => r.json())
      .then((data: ApiResponse) => {
        setProspects(data.data);
        setTotal(data.total);
        setTotalPages(data.totalPages);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [searchParams]);

  // Fetch filter options once
  useEffect(() => {
    fetch("/api/v1/sales/prospects/filters")
      .then(r => r.json())
      .then(setFilterOptions);
  }, []);

  // Search debounce
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput !== search) {
        router.push(buildUrl({ search: searchInput, page: "1" }));
      }
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Toggle sort
  const toggleSort = (col: string) => {
    const newOrder = sort === col && order === "asc" ? "desc" : "asc";
    router.push(buildUrl({ sort: col, order: newOrder, page: "1" }));
  };

  const sortIcon = (col: string) => {
    if (sort !== col) return "↕";
    return order === "asc" ? "↑" : "↓";
  };

  // Selection
  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
    setSelectAll(false);
    setSelectAllMatching(false);
  };

  const toggleSelectPage = () => {
    if (selectAll) {
      setSelected(new Set());
      setSelectAll(false);
    } else {
      setSelected(new Set(prospects.map(p => p.id)));
      setSelectAll(true);
    }
    setSelectAllMatching(false);
  };

  // Bulk action
  const doBulkAction = async (action: string, params?: Record<string, unknown>) => {
    if (selected.size === 0 && !selectAllMatching) return;
    setBulkLoading(true);

    // If selectAllMatching, we'd need all IDs — for now use selected
    const ids = Array.from(selected);
    
    try {
      const res = await fetch("/api/v1/sales/prospects/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ids, params }),
      });
      const result = await res.json();
      if (result.success) {
        setSelected(new Set());
        setSelectAll(false);
        // Refresh
        router.refresh();
        // Re-fetch
        const apiParams = new URLSearchParams(searchParams.toString());
        apiParams.set("limit", String(limit));
        const data: ApiResponse = await (await fetch(`/api/v1/sales/prospects?${apiParams}`)).json();
        setProspects(data.data);
        setTotal(data.total);
      }
    } finally {
      setBulkLoading(false);
    }
  };

  // Filter toggle helpers
  const toggleFilterValue = (key: string, value: string, current: string[]) => {
    const next = current.includes(value) ? current.filter(v => v !== value) : [...current, value];
    router.push(buildUrl({ [key]: next, page: "1" }));
  };

  const clearAllFilters = () => {
    router.push(buildUrl({ state: null, category: null, source: null, status: null, has_email: null, has_phone: null, icp_min: null, icp_max: null, page: "1" }));
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Prospects</h1>
          <p className="text-sm text-gray-500 mt-1">
            {total.toLocaleString()} companies{activeFilterCount > 0 ? " (filtered)" : ""}
          </p>
        </div>
      </div>

      {/* Search + Filter bar */}
      <div className="flex gap-3 mb-4">
        <div className="flex-1 relative">
          <input
            type="text"
            placeholder="Search prospects..."
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-800 dark:border-gray-600 dark:text-white"
          />
          {search && (
            <button onClick={() => { setSearchInput(""); router.push(buildUrl({ search: null, page: "1" })); }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">✕</button>
          )}
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`px-4 py-2.5 border rounded-lg text-sm font-medium flex items-center gap-2 ${
            activeFilterCount > 0 ? "bg-blue-50 border-blue-300 text-blue-700" : "border-gray-300 text-gray-700 hover:bg-gray-50"
          } dark:bg-gray-800 dark:border-gray-600 dark:text-gray-300`}
        >
          <span>Filters</span>
          {activeFilterCount > 0 && (
            <span className="bg-blue-600 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">{activeFilterCount}</span>
          )}
        </button>
        {activeFilterCount > 0 && (
          <button onClick={clearAllFilters} className="px-3 py-2.5 text-sm text-red-600 hover:text-red-800">Clear all</button>
        )}
      </div>

      {/* Filters panel */}
      {showFilters && filterOptions && (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 mb-4 grid grid-cols-2 md:grid-cols-4 gap-4">
          {/* State */}
          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">State</h4>
            <div className="max-h-48 overflow-y-auto space-y-1">
              {filterOptions.states.slice(0, 20).map(s => (
                <label key={s.state} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 px-1 rounded">
                  <input type="checkbox" checked={stateFilter.includes(s.state)} onChange={() => toggleFilterValue("state", s.state, stateFilter)} className="rounded" />
                  <span className="text-gray-700 dark:text-gray-300">{s.state}</span>
                  <span className="text-gray-400 text-xs ml-auto">{s.count.toLocaleString()}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Category */}
          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Category</h4>
            <div className="max-h-48 overflow-y-auto space-y-1">
              {filterOptions.categories.map(c => (
                <label key={c.category} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 px-1 rounded">
                  <input type="checkbox" checked={categoryFilter.includes(c.category)} onChange={() => toggleFilterValue("category", c.category, categoryFilter)} className="rounded" />
                  <span className="text-gray-700 dark:text-gray-300">{c.category}</span>
                  <span className="text-gray-400 text-xs ml-auto">{c.count.toLocaleString()}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Source */}
          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Source</h4>
            <div className="max-h-48 overflow-y-auto space-y-1">
              {filterOptions.sources.map(s => (
                <label key={s.source} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 px-1 rounded">
                  <input type="checkbox" checked={sourceFilter.includes(s.source)} onChange={() => toggleFilterValue("source", s.source, sourceFilter)} className="rounded" />
                  <span className="text-gray-700 dark:text-gray-300">{s.source}</span>
                  <span className="text-gray-400 text-xs ml-auto">{s.count.toLocaleString()}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Status + Toggles */}
          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Status</h4>
            <div className="space-y-1 mb-4">
              {filterOptions.statuses.map(s => (
                <label key={s.status} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 px-1 rounded">
                  <input type="checkbox" checked={statusFilter.includes(s.status)} onChange={() => toggleFilterValue("status", s.status, statusFilter)} className="rounded" />
                  <span className="text-gray-700 dark:text-gray-300">{s.status}</span>
                  <span className="text-gray-400 text-xs ml-auto">{s.count.toLocaleString()}</span>
                </label>
              ))}
            </div>

            <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Contact Info</h4>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={hasEmail === "true"} onChange={() => router.push(buildUrl({ has_email: hasEmail === "true" ? null : "true", page: "1" }))} className="rounded" />
                <span className="text-gray-700 dark:text-gray-300">Has Email</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={hasPhone === "true"} onChange={() => router.push(buildUrl({ has_phone: hasPhone === "true" ? null : "true", page: "1" }))} className="rounded" />
                <span className="text-gray-700 dark:text-gray-300">Has Phone</span>
              </label>
            </div>

            {filterOptions.icpRange && (
              <>
                <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2 mt-4">ICP Score</h4>
                <div className="flex gap-2">
                  <input type="number" placeholder="Min" value={icpMin || ""} onChange={e => router.push(buildUrl({ icp_min: e.target.value || null, page: "1" }))}
                    className="w-20 px-2 py-1 border rounded text-sm dark:bg-gray-700 dark:border-gray-600" />
                  <span className="text-gray-400">–</span>
                  <input type="number" placeholder="Max" value={icpMax || ""} onChange={e => router.push(buildUrl({ icp_max: e.target.value || null, page: "1" }))}
                    className="w-20 px-2 py-1 border rounded text-sm dark:bg-gray-700 dark:border-gray-600" />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg px-4 py-3 mb-4 flex items-center gap-3">
          <span className="text-sm font-medium text-blue-800 dark:text-blue-200">
            {selectAllMatching ? `All ${total.toLocaleString()} matching` : `${selected.size} selected`}
          </span>
          {selectAll && !selectAllMatching && total > limit && (
            <button onClick={() => setSelectAllMatching(true)} className="text-sm text-blue-600 hover:underline">
              Select all {total.toLocaleString()} matching
            </button>
          )}
          <div className="flex gap-2 ml-auto">
            <button onClick={() => doBulkAction("approve")} disabled={bulkLoading}
              className="px-3 py-1.5 bg-green-600 text-white text-sm rounded hover:bg-green-700 disabled:opacity-50">Approve</button>
            <button onClick={() => doBulkAction("reject")} disabled={bulkLoading}
              className="px-3 py-1.5 bg-red-600 text-white text-sm rounded hover:bg-red-700 disabled:opacity-50">Reject</button>
            <button onClick={() => { const tag = prompt("Enter tag:"); if (tag) doBulkAction("tag", { tag }); }} disabled={bulkLoading}
              className="px-3 py-1.5 bg-gray-600 text-white text-sm rounded hover:bg-gray-700 disabled:opacity-50">Tag</button>
            <button disabled className="px-3 py-1.5 bg-gray-300 text-gray-500 text-sm rounded cursor-not-allowed">Add to Campaign</button>
            <button disabled className="px-3 py-1.5 bg-gray-300 text-gray-500 text-sm rounded cursor-not-allowed">Enrich</button>
          </div>
          <button onClick={() => { setSelected(new Set()); setSelectAll(false); setSelectAllMatching(false); }}
            className="text-sm text-gray-500 hover:text-gray-700 ml-2">Cancel</button>
        </div>
      )}

      {/* DataTable */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-50 dark:bg-gray-900 text-gray-600 dark:text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-4 py-3 w-10">
                  <input type="checkbox" checked={selectAll} onChange={toggleSelectPage} className="rounded" />
                </th>
                <th className="px-4 py-3 cursor-pointer hover:text-gray-900" onClick={() => toggleSort("name")}>
                  Name {sortIcon("name")}
                </th>
                <th className="px-4 py-3">City</th>
                <th className="px-4 py-3 cursor-pointer hover:text-gray-900" onClick={() => toggleSort("state")}>
                  State {sortIcon("state")}
                </th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Phone</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3 cursor-pointer hover:text-gray-900" onClick={() => toggleSort("icp_score")}>
                  ICP {sortIcon("icp_score")}
                </th>
                <th className="px-4 py-3 cursor-pointer hover:text-gray-900" onClick={() => toggleSort("status")}>
                  Status {sortIcon("status")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {loading ? (
                <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-400">Loading...</td></tr>
              ) : prospects.length === 0 ? (
                <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-400">No prospects found</td></tr>
              ) : prospects.map(p => (
                <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
                  onClick={(e) => { if ((e.target as HTMLElement).tagName !== "INPUT") router.push(`/prospects/${p.id}`); }}>
                  <td className="px-4 py-3">
                    <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSelect(p.id)} className="rounded" />
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white max-w-[200px] truncate">{p.name}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{p.city}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{p.state}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{p.tags?.[0] || "—"}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400 text-xs">{p.source?.split("|")[0] || "—"}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400 text-xs">{p.phone || "—"}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400 text-xs max-w-[180px] truncate">{p.email || "—"}</td>
                  <td className="px-4 py-3">
                    {p.icp_score != null ? (
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        p.icp_score >= 80 ? "bg-green-100 text-green-800" :
                        p.icp_score >= 60 ? "bg-yellow-100 text-yellow-800" :
                        p.icp_score >= 40 ? "bg-orange-100 text-orange-800" :
                        "bg-gray-100 text-gray-600"
                      }`}>{p.icp_score}</span>
                    ) : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      p.status === "qualified" ? "bg-green-100 text-green-800" :
                      p.status === "contacted" ? "bg-blue-100 text-blue-800" :
                      p.status === "rejected" ? "bg-red-100 text-red-800" :
                      p.status === "customer" ? "bg-purple-100 text-purple-800" :
                      "bg-gray-100 text-gray-600"
                    }`}>{p.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
          <p className="text-sm text-gray-500">
            Showing {((page - 1) * limit + 1).toLocaleString()}–{Math.min(page * limit, total).toLocaleString()} of {total.toLocaleString()}
          </p>
          <div className="flex gap-1">
            <button
              disabled={page <= 1}
              onClick={() => router.push(buildUrl({ page: String(page - 1) }))}
              className="px-3 py-1.5 border rounded text-sm disabled:opacity-50 hover:bg-gray-100 dark:hover:bg-gray-800 dark:border-gray-600"
            >Prev</button>
            {/* Page numbers */}
            {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
              let pageNum: number;
              if (totalPages <= 7) pageNum = i + 1;
              else if (page <= 4) pageNum = i + 1;
              else if (page >= totalPages - 3) pageNum = totalPages - 6 + i;
              else pageNum = page - 3 + i;
              return (
                <button key={pageNum} onClick={() => router.push(buildUrl({ page: String(pageNum) }))}
                  className={`px-3 py-1.5 border rounded text-sm ${page === pageNum ? "bg-blue-600 text-white border-blue-600" : "hover:bg-gray-100 dark:hover:bg-gray-800 dark:border-gray-600"}`}>
                  {pageNum}
                </button>
              );
            })}
            <button
              disabled={page >= totalPages}
              onClick={() => router.push(buildUrl({ page: String(page + 1) }))}
              className="px-3 py-1.5 border rounded text-sm disabled:opacity-50 hover:bg-gray-100 dark:hover:bg-gray-800 dark:border-gray-600"
            >Next</button>
          </div>
        </div>
      </div>
    </div>
  );
}
