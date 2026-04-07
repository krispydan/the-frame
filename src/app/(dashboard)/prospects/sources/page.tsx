"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Database, Filter, CheckCircle2, XCircle, ExternalLink, ChevronDown,
  Loader2, ArrowLeft,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

const SOURCE_TYPE_LABELS: Record<string, string> = {
  storemapper: "StoreMapper",
  outscraper: "Outscraper",
  manual: "Manual",
  csv: "CSV Import",
  "chrome-ext": "Chrome Extension",
};

const SOURCE_TYPE_COLORS: Record<string, string> = {
  storemapper: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  outscraper: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
  manual: "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300",
  csv: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  "chrome-ext": "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
};

interface LeadSource {
  source_type: string | null;
  source_id: string | null;
  source_query: string | null;
  prospect_count: number;
  qualified_count: number;
  rejected_count: number;
  new_count: number;
  industry: string | null;
  relevant: boolean | null;
  samples: string[] | null;
}

interface Summary {
  total_sources: number;
  total_prospects: number;
  by_type: Record<string, { count: number; prospect_count: number }>;
}

export default function LeadSourcesPage() {
  const router = useRouter();
  const [sources, setSources] = useState<LeadSource[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [relevantFilter, setRelevantFilter] = useState<string>("all");
  const [bulkDialog, setBulkDialog] = useState<{ source: LeadSource; action: "approve_all" | "reject_all" } | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);

  const fetchSources = async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (typeFilter !== "all") params.set("source_type", typeFilter);
    const res = await fetch(`/api/v1/sales/prospects/sources?${params}`);
    const data = await res.json();
    setSources(data.data || []);
    setSummary(data.summary || null);
    setLoading(false);
  };

  useEffect(() => { fetchSources(); }, [typeFilter]);

  const filteredSources = sources.filter(s => {
    if (relevantFilter === "relevant") return s.relevant === true;
    if (relevantFilter === "irrelevant") return s.relevant === false;
    if (relevantFilter === "unclassified") return s.relevant === null && s.source_type === "storemapper";
    return true;
  });

  const doBulkAction = async () => {
    if (!bulkDialog) return;
    setBulkLoading(true);
    try {
      await fetch("/api/v1/sales/prospects/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: bulkDialog.action,
          source_type: bulkDialog.source.source_type,
          source_id: bulkDialog.source.source_id,
        }),
      });
      setBulkDialog(null);
      await fetchSources();
    } finally {
      setBulkLoading(false);
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-full xl:max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" onClick={() => router.push("/prospects")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Database className="w-6 h-6" /> Lead Sources
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {summary ? `${summary.total_sources} sources · ${summary.total_prospects.toLocaleString()} total prospects` : "Loading..."}
          </p>
        </div>
      </div>

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
          {Object.entries(summary.by_type).map(([type, stats]) => (
            <Card key={type} className="cursor-pointer hover:ring-2 hover:ring-blue-200 transition-all"
              onClick={() => setTypeFilter(typeFilter === type ? "all" : type)}>
              <CardContent className="pt-4 pb-4">
                <Badge className={`${SOURCE_TYPE_COLORS[type] || "bg-gray-100 text-gray-600"} mb-2`}>
                  {SOURCE_TYPE_LABELS[type] || type}
                </Badge>
                <p className="text-2xl font-bold text-gray-900 dark:text-white">{stats.count}</p>
                <p className="text-xs text-gray-500">{stats.prospect_count.toLocaleString()} prospects</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[200px]">
            <Filter className="w-4 h-4 mr-2" />
            <SelectValue placeholder="All source types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All source types</SelectItem>
            {Object.entries(SOURCE_TYPE_LABELS).map(([key, label]) => (
              <SelectItem key={key} value={key}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={relevantFilter} onValueChange={setRelevantFilter}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="All relevance" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All relevance</SelectItem>
            <SelectItem value="relevant">✅ Relevant</SelectItem>
            <SelectItem value="irrelevant">❌ Irrelevant</SelectItem>
            <SelectItem value="unclassified">❓ Unclassified</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Sources table */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-50 dark:bg-gray-900 text-gray-600 dark:text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-4 py-3">Source Type</th>
                <th className="px-4 py-3">Source ID</th>
                <th className="px-4 py-3">Industry</th>
                <th className="px-4 py-3">Relevant</th>
                <th className="px-4 py-3 text-right">Prospects</th>
                <th className="px-4 py-3 text-right">New</th>
                <th className="px-4 py-3 text-right">Qualified</th>
                <th className="px-4 py-3 text-right">Rejected</th>
                <th className="px-4 py-3">Samples</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {loading ? (
                <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-400">
                  <Loader2 className="w-5 h-5 animate-spin inline mr-2" />Loading sources...
                </td></tr>
              ) : filteredSources.length === 0 ? (
                <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-400">
                  No sources found. Source data will appear after prospects are imported with source tracking.
                </td></tr>
              ) : filteredSources.map((s, i) => (
                <tr key={`${s.source_type}-${s.source_id}-${i}`} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                  <td className="px-4 py-3">
                    <Badge className={SOURCE_TYPE_COLORS[s.source_type || ""] || "bg-gray-100 text-gray-600"}>
                      {SOURCE_TYPE_LABELS[s.source_type || ""] || s.source_type || "Unknown"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-gray-700 dark:text-gray-300 font-mono text-xs">
                    {s.source_id || "—"}
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400 capitalize">
                    {s.industry || "—"}
                  </td>
                  <td className="px-4 py-3">
                    {s.relevant === true ? (
                      <span className="inline-flex items-center gap-1 text-green-600"><CheckCircle2 className="w-4 h-4" /> Yes</span>
                    ) : s.relevant === false ? (
                      <span className="inline-flex items-center gap-1 text-red-500"><XCircle className="w-4 h-4" /> No</span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-900 dark:text-white">
                    {s.prospect_count.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-500">{s.new_count.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right text-green-600">{s.qualified_count.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right text-red-500">{s.rejected_count.toLocaleString()}</td>
                  <td className="px-4 py-3 text-xs text-gray-500 max-w-[200px] truncate">
                    {s.samples?.join(", ") || "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <Link
                        href={`/prospects?${new URLSearchParams({ source_type: s.source_type || "", ...(s.source_id ? { source_id: s.source_id } : {}) })}`}
                        className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-600 text-gray-500 hover:text-blue-600"
                        title="View prospects"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </Link>
                      <button
                        onClick={() => setBulkDialog({ source: s, action: "approve_all" })}
                        className="p-1.5 rounded hover:bg-green-50 dark:hover:bg-green-900/20 text-gray-500 hover:text-green-600"
                        title="Approve all from this source"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setBulkDialog({ source: s, action: "reject_all" })}
                        className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-500 hover:text-red-600"
                        title="Reject all from this source"
                      >
                        <XCircle className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Bulk action confirmation dialog */}
      <Dialog open={!!bulkDialog} onOpenChange={() => setBulkDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {bulkDialog?.action === "approve_all" ? "Approve All Prospects" : "Reject All Prospects"}
            </DialogTitle>
          </DialogHeader>
          {bulkDialog && (
            <div className="py-4">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                This will {bulkDialog.action === "approve_all" ? "approve (qualify)" : "reject (disqualify)"}{" "}
                all <strong>{bulkDialog.source.prospect_count.toLocaleString()}</strong> prospects from{" "}
                <Badge className={SOURCE_TYPE_COLORS[bulkDialog.source.source_type || ""] || "bg-gray-100"}>
                  {SOURCE_TYPE_LABELS[bulkDialog.source.source_type || ""] || bulkDialog.source.source_type}
                </Badge>
                {bulkDialog.source.source_id && (
                  <span className="font-mono text-xs ml-1">#{bulkDialog.source.source_id}</span>
                )}
                {bulkDialog.source.industry && (
                  <span className="ml-1">({bulkDialog.source.industry})</span>
                )}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDialog(null)}>Cancel</Button>
            <Button
              variant={bulkDialog?.action === "approve_all" ? "default" : "destructive"}
              onClick={doBulkAction}
              disabled={bulkLoading}
            >
              {bulkLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              {bulkDialog?.action === "approve_all" ? "Approve All" : "Reject All"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
