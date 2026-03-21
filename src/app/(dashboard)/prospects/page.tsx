"use client";

import { Suspense, useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ListFilter, Bookmark, Plus, X, ChevronRight, Download, Search, Merge, AlertTriangle, CheckCircle2 } from "lucide-react";

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
  enrichment_status: string;
}

interface FilterOptions {
  states: { state: string; count: number }[];
  statuses: { status: string; count: number }[];
  sources: { source: string; count: number }[];
  categories: { category: string; count: number }[];
  icpRange: { min: number; max: number };
}

interface SmartList {
  id: string;
  name: string;
  description: string | null;
  filters: Record<string, unknown>;
  isDefault: boolean;
  resultCount: number;
}

interface Campaign {
  id: string;
  name: string;
  type: string;
  status: string;
}

interface DuplicatePair {
  id1: string;
  id2: string;
  name1: string;
  name2: string;
  city1: string;
  city2: string;
  state1: string;
  state2: string;
  confidence: number;
  reasons: string[];
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
  const [smartLists, setSmartLists] = useState<SmartList[]>([]);
  const [showSmartLists, setShowSmartLists] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveListName, setSaveListName] = useState("");
  const [saveListDesc, setSaveListDesc] = useState("");
  const [activeSmartList, setActiveSmartList] = useState<string | null>(null);

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

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectAll, setSelectAll] = useState(false);
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [searchInput, setSearchInput] = useState(search);

  // Bulk action dropdowns
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [showCampaignPicker, setShowCampaignPicker] = useState(false);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState("");
  const tagPickerRef = useRef<HTMLDivElement>(null);
  const campaignPickerRef = useRef<HTMLDivElement>(null);

  // Duplicate detection state
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicatePair[]>([]);
  const [dupLoading, setDupLoading] = useState(false);
  const [mergePair, setMergePair] = useState<DuplicatePair | null>(null);
  const [mergeLoading, setMergeLoading] = useState(false);
  const [mergePrimaryId, setMergePrimaryId] = useState<string | null>(null);
  const [mergeSuccess, setMergeSuccess] = useState<string | null>(null);

  const activeFilterCount = stateFilter.length + categoryFilter.length + sourceFilter.length + statusFilter.length 
    + (hasEmail ? 1 : 0) + (hasPhone ? 1 : 0) + (icpMin ? 1 : 0) + (icpMax ? 1 : 0);

  const buildUrl = useCallback((overrides: Record<string, string | string[] | null>) => {
    const p = new URLSearchParams();
    const vals: Record<string, string | string[] | null> = {
      page: String(page), search, sort, order,
      state: stateFilter, category: categoryFilter, source: sourceFilter, status: statusFilter,
      has_email: hasEmail, has_phone: hasPhone, icp_min: icpMin, icp_max: icpMax,
      ...overrides,
    };
    for (const [k, v] of Object.entries(vals)) {
      if (v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
      if (Array.isArray(v)) v.forEach(val => p.append(k, val));
      else p.set(k, v);
    }
    return `/prospects?${p.toString()}`;
  }, [page, search, sort, order, stateFilter, categoryFilter, sourceFilter, statusFilter, hasEmail, hasPhone, icpMin, icpMax]);

  const currentFilters = useCallback(() => {
    const f: Record<string, unknown> = {};
    if (stateFilter.length) f.state = stateFilter;
    if (categoryFilter.length) f.category = categoryFilter;
    if (sourceFilter.length) f.source = sourceFilter;
    if (statusFilter.length) f.status = statusFilter;
    if (hasEmail) f.has_email = hasEmail;
    if (hasPhone) f.has_phone = hasPhone;
    if (icpMin) f.icp_min = icpMin;
    if (icpMax) f.icp_max = icpMax;
    return f;
  }, [stateFilter, categoryFilter, sourceFilter, statusFilter, hasEmail, hasPhone, icpMin, icpMax]);

  // Fetch data
  useEffect(() => {
    setLoading(true);
    const apiParams = new URLSearchParams(searchParams.toString());
    apiParams.set("limit", String(limit));
    if (!apiParams.has("page")) apiParams.set("page", "1");
    fetch(`/api/v1/sales/prospects?${apiParams.toString()}`)
      .then(r => r.json())
      .then((data: ApiResponse) => {
        setProspects(data.data); setTotal(data.total); setTotalPages(data.totalPages); setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [searchParams]);

  // Fetch filter options + smart lists + campaigns
  useEffect(() => {
    fetch("/api/v1/sales/prospects/filters").then(r => r.json()).then(data => {
      setFilterOptions(data);
      // Extract unique tags from categories
      if (data.categories) {
        setAvailableTags(data.categories.map((c: { category: string }) => c.category).filter(Boolean));
      }
    });
    fetch("/api/v1/sales/smart-lists").then(r => r.json()).then(d => setSmartLists(d.data || []));
    fetch("/api/v1/sales/campaigns?limit=100").then(r => r.json()).then(d => setCampaigns(d.data || []));
  }, []);

  // Search debounce
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput !== search) router.push(buildUrl({ search: searchInput, page: "1" }));
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (tagPickerRef.current && !tagPickerRef.current.contains(e.target as Node)) setShowTagPicker(false);
      if (campaignPickerRef.current && !campaignPickerRef.current.contains(e.target as Node)) setShowCampaignPicker(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const toggleSort = (col: string) => {
    const newOrder = sort === col && order === "asc" ? "desc" : "asc";
    router.push(buildUrl({ sort: col, order: newOrder, page: "1" }));
  };
  const sortIcon = (col: string) => sort !== col ? "↕" : order === "asc" ? "↑" : "↓";

  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next); setSelectAll(false); setSelectAllMatching(false);
  };
  const toggleSelectPage = () => {
    if (selectAll) { setSelected(new Set()); setSelectAll(false); }
    else { setSelected(new Set(prospects.map(p => p.id))); setSelectAll(true); }
    setSelectAllMatching(false);
  };

  const refreshProspects = async () => {
    const apiParams = new URLSearchParams(searchParams.toString());
    apiParams.set("limit", String(limit));
    const data: ApiResponse = await (await fetch(`/api/v1/sales/prospects?${apiParams}`)).json();
    setProspects(data.data); setTotal(data.total); setTotalPages(data.totalPages);
  };

  const doBulkAction = async (action: string, params?: Record<string, unknown>) => {
    if (selected.size === 0 && !selectAllMatching) return;
    setBulkLoading(true);
    try {
      const res = await fetch("/api/v1/sales/prospects/bulk", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ids: Array.from(selected), params }),
      });
      const result = await res.json();
      if (result.success) {
        setSelected(new Set()); setSelectAll(false); setSelectAllMatching(false);
        await refreshProspects();
      }
    } finally { setBulkLoading(false); }
  };

  const exportSelectedCSV = () => {
    const selectedProspects = prospects.filter(p => selected.has(p.id));
    if (selectedProspects.length === 0) return;
    
    const headers = ["Name", "City", "State", "Source", "Phone", "Email", "ICP Score", "Status", "Tags"];
    const rows = selectedProspects.map(p => [
      `"${(p.name || "").replace(/"/g, '""')}"`,
      `"${(p.city || "").replace(/"/g, '""')}"`,
      `"${(p.state || "").replace(/"/g, '""')}"`,
      `"${(p.source || "").replace(/"/g, '""')}"`,
      `"${(p.phone || "").replace(/"/g, '""')}"`,
      `"${(p.email || "").replace(/"/g, '""')}"`,
      p.icp_score ?? "",
      p.status || "",
      `"${(p.tags || []).join(", ")}"`,
    ]);
    
    const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `prospects-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  // Duplicate detection
  const findDuplicates = async () => {
    setDupLoading(true); setShowDuplicates(true); setMergeSuccess(null);
    try {
      const res = await fetch("/api/v1/sales/duplicates?limit=50");
      const data = await res.json();
      setDuplicates(data.data || []);
    } finally { setDupLoading(false); }
  };

  const doMerge = async () => {
    if (!mergePair || !mergePrimaryId) return;
    setMergeLoading(true);
    const secondaryId = mergePrimaryId === mergePair.id1 ? mergePair.id2 : mergePair.id1;
    try {
      const res = await fetch("/api/v1/sales/duplicates/merge", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ primaryId: mergePrimaryId, secondaryId }),
      });
      const result = await res.json();
      if (result.success) {
        setDuplicates(prev => prev.filter(d => !(d.id1 === mergePair.id1 && d.id2 === mergePair.id2)));
        setMergePair(null); setMergePrimaryId(null);
        setMergeSuccess("Records merged successfully!");
        await refreshProspects();
        setTimeout(() => setMergeSuccess(null), 3000);
      }
    } finally { setMergeLoading(false); }
  };

  const toggleFilterValue = (key: string, value: string, current: string[]) => {
    const next = current.includes(value) ? current.filter(v => v !== value) : [...current, value];
    router.push(buildUrl({ [key]: next, page: "1" }));
    setActiveSmartList(null);
  };
  const clearAllFilters = () => {
    router.push(buildUrl({ state: null, category: null, source: null, status: null, has_email: null, has_phone: null, icp_min: null, icp_max: null, page: "1" }));
    setActiveSmartList(null);
  };

  const applySmartList = (list: SmartList) => {
    const f = list.filters;
    router.push(buildUrl({
      state: (f.state as string[]) || null, category: (f.category as string[]) || null,
      source: (f.source as string[]) || null, status: (f.status as string[]) || null,
      has_email: (f.has_email as string) || null, has_phone: (f.has_phone as string) || null,
      icp_min: (f.icp_min as string) || null, icp_max: (f.icp_max as string) || null,
      page: "1",
    }));
    setActiveSmartList(list.id); setShowSmartLists(false);
  };

  const saveAsSmartList = async () => {
    if (!saveListName.trim()) return;
    const res = await fetch("/api/v1/sales/smart-lists", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: saveListName, description: saveListDesc, filters: currentFilters() }),
    });
    if (res.ok) {
      const d = await res.json();
      setSmartLists(prev => [...prev, d.data]);
      setShowSaveDialog(false); setSaveListName(""); setSaveListDesc("");
    }
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Prospects</h1>
          <p className="text-sm text-gray-500 mt-1">
            {total.toLocaleString()} companies{activeFilterCount > 0 ? " (filtered)" : ""}
            {activeSmartList && smartLists.find(l => l.id === activeSmartList) && (
              <span className="ml-2 text-blue-600">
                — {smartLists.find(l => l.id === activeSmartList)!.name}
              </span>
            )}
          </p>
        </div>
        <button onClick={findDuplicates}
          className="px-4 py-2.5 border border-amber-300 bg-amber-50 text-amber-700 rounded-lg text-sm font-medium flex items-center gap-2 hover:bg-amber-100 dark:bg-amber-900/20 dark:border-amber-700 dark:text-amber-400">
          <Search className="w-4 h-4" />
          Find Duplicates
        </button>
      </div>

      {/* Search + Filter + Smart Lists bar */}
      <div className="flex gap-3 mb-4">
        <div className="flex-1 relative">
          <input type="text" placeholder="Search prospects..." value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-800 dark:border-gray-600 dark:text-white" />
          {search && (
            <button onClick={() => { setSearchInput(""); router.push(buildUrl({ search: null, page: "1" })); }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">✕</button>
          )}
        </div>

        {/* Smart Lists dropdown */}
        <div className="relative">
          <button onClick={() => setShowSmartLists(!showSmartLists)}
            className={`px-4 py-2.5 border rounded-lg text-sm font-medium flex items-center gap-2 ${
              activeSmartList ? "bg-purple-50 border-purple-300 text-purple-700" : "border-gray-300 text-gray-700 hover:bg-gray-50"
            } dark:bg-gray-800 dark:border-gray-600 dark:text-gray-300`}>
            <Bookmark className="w-4 h-4" />
            <span>Smart Lists</span>
          </button>
          {showSmartLists && (
            <div className="absolute right-0 top-full mt-1 w-80 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50">
              <div className="p-3 border-b border-gray-100 dark:border-gray-700">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Saved Lists</h3>
              </div>
              <div className="max-h-64 overflow-y-auto">
                {smartLists.map(list => (
                  <button key={list.id} onClick={() => applySmartList(list)}
                    className={`w-full text-left px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center justify-between ${
                      activeSmartList === list.id ? "bg-purple-50 dark:bg-purple-900/20" : ""
                    }`}>
                    <div>
                      <div className="text-sm font-medium text-gray-900 dark:text-white flex items-center gap-1.5">
                        {list.name}
                        {list.isDefault && <span className="text-[10px] bg-gray-100 dark:bg-gray-700 text-gray-500 px-1 rounded">DEFAULT</span>}
                      </div>
                      {list.description && <p className="text-xs text-gray-500 mt-0.5">{list.description}</p>}
                    </div>
                    <span className="text-xs text-gray-400 ml-2 shrink-0">{list.resultCount.toLocaleString()}</span>
                  </button>
                ))}
              </div>
              {activeSmartList && (
                <div className="p-2 border-t border-gray-100 dark:border-gray-700">
                  <button onClick={() => { clearAllFilters(); setShowSmartLists(false); }}
                    className="w-full text-sm text-red-600 hover:text-red-800 py-1">Clear Smart List</button>
                </div>
              )}
            </div>
          )}
        </div>

        <button onClick={() => setShowFilters(!showFilters)}
          className={`px-4 py-2.5 border rounded-lg text-sm font-medium flex items-center gap-2 ${
            activeFilterCount > 0 ? "bg-blue-50 border-blue-300 text-blue-700" : "border-gray-300 text-gray-700 hover:bg-gray-50"
          } dark:bg-gray-800 dark:border-gray-600 dark:text-gray-300`}>
          <ListFilter className="w-4 h-4" />
          <span>Filters</span>
          {activeFilterCount > 0 && (
            <span className="bg-blue-600 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">{activeFilterCount}</span>
          )}
        </button>

        {activeFilterCount > 0 && !activeSmartList && (
          <button onClick={() => setShowSaveDialog(true)}
            className="px-3 py-2.5 border border-dashed border-purple-300 rounded-lg text-sm text-purple-600 hover:bg-purple-50 flex items-center gap-1.5">
            <Plus className="w-4 h-4" /> Save List
          </button>
        )}

        {activeFilterCount > 0 && (
          <button onClick={clearAllFilters} className="px-3 py-2.5 text-sm text-red-600 hover:text-red-800">Clear all</button>
        )}
      </div>

      {/* Save Smart List Dialog */}
      {showSaveDialog && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl p-6 w-[420px]">
            <h3 className="text-lg font-semibold mb-4">Save as Smart List</h3>
            <input type="text" placeholder="List name" value={saveListName} onChange={e => setSaveListName(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm mb-3 dark:bg-gray-700 dark:border-gray-600" autoFocus />
            <textarea placeholder="Description (optional)" value={saveListDesc} onChange={e => setSaveListDesc(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm mb-3 h-20 dark:bg-gray-700 dark:border-gray-600" />
            <p className="text-xs text-gray-500 mb-4">{activeFilterCount} active filter{activeFilterCount !== 1 ? "s" : ""} will be saved</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowSaveDialog(false)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
              <button onClick={saveAsSmartList} disabled={!saveListName.trim()}
                className="px-4 py-2 text-sm bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Filters panel */}
      {showFilters && filterOptions && (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 mb-4 grid grid-cols-2 md:grid-cols-4 gap-4">
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

      {/* Bulk action bar — floating at bottom when items selected */}
      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl px-5 py-3 flex items-center gap-3">
          <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {selectAllMatching ? `All ${total.toLocaleString()} matching` : `${selected.size} selected`}
          </span>
          {selectAll && !selectAllMatching && total > limit && (
            <button onClick={() => setSelectAllMatching(true)} className="text-sm text-blue-600 hover:underline">
              Select all {total.toLocaleString()}
            </button>
          )}
          <div className="w-px h-6 bg-gray-200 dark:bg-gray-600" />
          <button onClick={() => doBulkAction("approve")} disabled={bulkLoading}
            className="px-3 py-1.5 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium">
            ✓ Approve
          </button>
          <button onClick={() => doBulkAction("reject")} disabled={bulkLoading}
            className="px-3 py-1.5 bg-red-600 text-white text-sm rounded-lg hover:bg-red-700 disabled:opacity-50 font-medium">
            ✕ Reject
          </button>

          {/* Tag picker dropdown */}
          <div className="relative" ref={tagPickerRef}>
            <button onClick={() => { setShowTagPicker(!showTagPicker); setShowCampaignPicker(false); }} disabled={bulkLoading}
              className="px-3 py-1.5 bg-gray-700 text-white text-sm rounded-lg hover:bg-gray-800 disabled:opacity-50 font-medium">
              🏷 Add Tag
            </button>
            {showTagPicker && (
              <div className="absolute bottom-full mb-2 left-0 w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl">
                <div className="p-2 border-b border-gray-100 dark:border-gray-700">
                  <input type="text" placeholder="New tag..." value={newTag} onChange={e => setNewTag(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && newTag.trim()) { doBulkAction("tag", { tag: newTag.trim() }); setNewTag(""); setShowTagPicker(false); } }}
                    className="w-full px-2 py-1.5 border rounded text-sm dark:bg-gray-700 dark:border-gray-600" autoFocus />
                </div>
                <div className="max-h-48 overflow-y-auto p-1">
                  {availableTags.map(tag => (
                    <button key={tag} onClick={() => { doBulkAction("tag", { tag }); setShowTagPicker(false); }}
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-700 dark:text-gray-300">
                      {tag}
                    </button>
                  ))}
                  {availableTags.length === 0 && !newTag && (
                    <p className="px-3 py-2 text-xs text-gray-400">Type to create a new tag</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Campaign picker dropdown */}
          <div className="relative" ref={campaignPickerRef}>
            <button onClick={() => { setShowCampaignPicker(!showCampaignPicker); setShowTagPicker(false); }} disabled={bulkLoading}
              className="px-3 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50 font-medium">
              📧 Add to Campaign
            </button>
            {showCampaignPicker && (
              <div className="absolute bottom-full mb-2 right-0 w-64 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl">
                <div className="p-2 border-b border-gray-100 dark:border-gray-700">
                  <p className="text-xs font-semibold text-gray-500 uppercase">Select Campaign</p>
                </div>
                <div className="max-h-48 overflow-y-auto p-1">
                  {campaigns.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-gray-400">No campaigns found</p>
                  ) : campaigns.map(c => (
                    <button key={c.id} onClick={() => { doBulkAction("assign", { owner_id: c.id }); setShowCampaignPicker(false); }}
                      className="w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
                      <div className="text-sm font-medium text-gray-900 dark:text-white">{c.name}</div>
                      <div className="text-xs text-gray-400">{c.type} · {c.status}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Bulk Enrich */}
          <button onClick={async () => {
            setBulkLoading(true);
            try {
              await fetch("/api/v1/sales/enrich", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ companyIds: Array.from(selected) }),
              });
              await refreshProspects();
            } finally { setBulkLoading(false); }
          }} disabled={bulkLoading}
            className="px-3 py-1.5 bg-amber-600 text-white text-sm rounded-lg hover:bg-amber-700 disabled:opacity-50 font-medium flex items-center gap-1.5">
            ✨ Enrich
          </button>

          {/* Export CSV */}
          <button onClick={exportSelectedCSV} disabled={bulkLoading}
            className="px-3 py-1.5 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-sm rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 font-medium flex items-center gap-1.5">
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>

          <div className="w-px h-6 bg-gray-200 dark:bg-gray-600" />
          <button onClick={() => { setSelected(new Set()); setSelectAll(false); setSelectAllMatching(false); }}
            className="text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Duplicates Dialog */}
      {showDuplicates && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-[800px] max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700">
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5 text-amber-500" /> Duplicate Detection
                </h3>
                <p className="text-sm text-gray-500 mt-0.5">{duplicates.length} potential duplicate pairs found</p>
              </div>
              <button onClick={() => { setShowDuplicates(false); setMergePair(null); }} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            {mergeSuccess && (
              <div className="mx-5 mt-3 px-3 py-2 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg text-sm text-green-700 dark:text-green-400 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" /> {mergeSuccess}
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-5">
              {dupLoading ? (
                <div className="text-center py-12 text-gray-400">Scanning for duplicates...</div>
              ) : duplicates.length === 0 ? (
                <div className="text-center py-12 text-gray-400">
                  <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-green-400" />
                  No duplicates found!
                </div>
              ) : (
                <div className="space-y-3">
                  {duplicates.map((dup, i) => (
                    <div key={`${dup.id1}-${dup.id2}`}
                      className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 hover:border-gray-300 dark:hover:border-gray-600 transition-colors">
                      <div className="flex items-start justify-between">
                        <div className="flex-1 grid grid-cols-2 gap-4">
                          <div>
                            <p className="font-medium text-gray-900 dark:text-white text-sm">{dup.name1}</p>
                            <p className="text-xs text-gray-500">{dup.city1}, {dup.state1}</p>
                          </div>
                          <div>
                            <p className="font-medium text-gray-900 dark:text-white text-sm">{dup.name2}</p>
                            <p className="text-xs text-gray-500">{dup.city2}, {dup.state2}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 ml-4">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${
                            dup.confidence >= 90 ? "bg-red-100 text-red-800" :
                            dup.confidence >= 75 ? "bg-amber-100 text-amber-800" : "bg-gray-100 text-gray-600"
                          }`}>
                            {Math.round(dup.confidence)}% match
                          </span>
                          <button onClick={() => { setMergePair(dup); setMergePrimaryId(dup.id1); }}
                            className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg hover:bg-blue-700 font-medium flex items-center gap-1">
                            <Merge className="w-3 h-3" /> Merge
                          </button>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {dup.reasons.map((r, j) => (
                          <span key={j} className="text-[11px] bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 px-2 py-0.5 rounded">{r}</span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Merge confirmation dialog */}
      {mergePair && (
        <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-[560px] p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1 flex items-center gap-2">
              <Merge className="w-5 h-5 text-blue-600" /> Merge Records
            </h3>
            <p className="text-sm text-gray-500 mb-5">Select which record to keep as primary. The other will be merged into it and deleted.</p>
            
            <div className="space-y-3 mb-6">
              <label className={`flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
                mergePrimaryId === mergePair.id1 ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20" : "border-gray-200 dark:border-gray-700 hover:border-gray-300"
              }`} onClick={() => setMergePrimaryId(mergePair.id1)}>
                <input type="radio" name="primary" checked={mergePrimaryId === mergePair.id1} onChange={() => setMergePrimaryId(mergePair.id1)}
                  className="mt-0.5" />
                <div>
                  <p className="font-medium text-gray-900 dark:text-white text-sm">{mergePair.name1}</p>
                  <p className="text-xs text-gray-500">{mergePair.city1}, {mergePair.state1}</p>
                  {mergePrimaryId === mergePair.id1 && <span className="text-[11px] text-blue-600 font-medium">← Primary (kept)</span>}
                </div>
              </label>
              <label className={`flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
                mergePrimaryId === mergePair.id2 ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20" : "border-gray-200 dark:border-gray-700 hover:border-gray-300"
              }`} onClick={() => setMergePrimaryId(mergePair.id2)}>
                <input type="radio" name="primary" checked={mergePrimaryId === mergePair.id2} onChange={() => setMergePrimaryId(mergePair.id2)}
                  className="mt-0.5" />
                <div>
                  <p className="font-medium text-gray-900 dark:text-white text-sm">{mergePair.name2}</p>
                  <p className="text-xs text-gray-500">{mergePair.city2}, {mergePair.state2}</p>
                  {mergePrimaryId === mergePair.id2 && <span className="text-[11px] text-blue-600 font-medium">← Primary (kept)</span>}
                </div>
              </label>
            </div>

            <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800 rounded-lg p-3 mb-5 text-xs text-amber-700 dark:text-amber-400">
              <strong>What happens on merge:</strong> All stores, contacts, deals, and activities from the secondary record will be moved to the primary. The secondary record will be permanently deleted.
            </div>

            <div className="flex gap-2 justify-end">
              <button onClick={() => { setMergePair(null); setMergePrimaryId(null); }}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 dark:text-gray-400">Cancel</button>
              <button onClick={doMerge} disabled={mergeLoading || !mergePrimaryId}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">
                {mergeLoading ? "Merging..." : "Merge Records"}
              </button>
            </div>
          </div>
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
                <th className="px-4 py-3 cursor-pointer hover:text-gray-900" onClick={() => toggleSort("name")}>Name {sortIcon("name")}</th>
                <th className="px-4 py-3">City</th>
                <th className="px-4 py-3 cursor-pointer hover:text-gray-900" onClick={() => toggleSort("state")}>State {sortIcon("state")}</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Phone</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3 cursor-pointer hover:text-gray-900" onClick={() => toggleSort("icp_score")}>ICP {sortIcon("icp_score")}</th>
                <th className="px-4 py-3 cursor-pointer hover:text-gray-900" onClick={() => toggleSort("status")}>Status {sortIcon("status")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {loading ? (
                <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-400">Loading...</td></tr>
              ) : prospects.length === 0 ? (
                <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-400">No prospects found</td></tr>
              ) : prospects.map(p => (
                <tr key={p.id} className={`hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer ${selected.has(p.id) ? "bg-blue-50/50 dark:bg-blue-900/10" : ""}`}
                  onClick={(e) => { if ((e.target as HTMLElement).tagName !== "INPUT") router.push(`/prospects/${p.id}`); }}>
                  <td className="px-4 py-3">
                    <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSelect(p.id)} className="rounded" />
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white max-w-[200px] truncate flex items-center gap-1.5">
                    {p.enrichment_status === "enriched" ? (
                      <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" title="Enriched" />
                    ) : p.enrichment_status === "failed" ? (
                      <span className="w-2 h-2 rounded-full bg-red-400 shrink-0" title="Enrichment failed" />
                    ) : p.enrichment_status === "queued" ? (
                      <span className="w-2 h-2 rounded-full bg-yellow-400 shrink-0 animate-pulse" title="Enrichment queued" />
                    ) : (
                      <span className="w-2 h-2 rounded-full bg-gray-300 shrink-0" title="Not enriched" />
                    )}
                    {p.name}
                  </td>
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
                        p.icp_score >= 40 ? "bg-orange-100 text-orange-800" : "bg-gray-100 text-gray-600"
                      }`}>{p.icp_score}</span>
                    ) : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      p.status === "qualified" ? "bg-green-100 text-green-800" :
                      p.status === "contacted" ? "bg-blue-100 text-blue-800" :
                      p.status === "rejected" ? "bg-red-100 text-red-800" :
                      p.status === "customer" ? "bg-purple-100 text-purple-800" : "bg-gray-100 text-gray-600"
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
            <button disabled={page <= 1} onClick={() => router.push(buildUrl({ page: String(page - 1) }))}
              className="px-3 py-1.5 border rounded text-sm disabled:opacity-50 hover:bg-gray-100 dark:hover:bg-gray-800 dark:border-gray-600">Prev</button>
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
            <button disabled={page >= totalPages} onClick={() => router.push(buildUrl({ page: String(page + 1) }))}
              className="px-3 py-1.5 border rounded text-sm disabled:opacity-50 hover:bg-gray-100 dark:hover:bg-gray-800 dark:border-gray-600">Next</button>
          </div>
        </div>
      </div>
    </div>
  );
}
