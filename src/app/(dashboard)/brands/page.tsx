"use client";

import { Suspense, useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Building, ExternalLink, Search, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface BrandAccount {
  id: string;
  external_id: string;
  name: string;
  website: string | null;
  sector: string | null;
  relevance: string;
  brand_type: string;
  us_locations: number;
  total_locations: number;
  top_country: string | null;
  match_count: number;
}

interface ApiResponse {
  data: BrandAccount[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

const relevanceColors: Record<string, string> = {
  relevant: "bg-green-100 text-green-800",
  irrelevant: "bg-red-100 text-red-800",
  needs_review: "bg-yellow-100 text-yellow-800",
};

const brandTypeLabels: Record<string, string> = {
  wholesale: "Wholesale",
  own_store: "Own Store",
  unknown: "Unknown",
};

const sectorOptions = [
  "eyewear", "fashion", "beauty", "lifestyle", "food_bev",
  "accessories", "home", "outdoor", "health", "kids",
];

export default function BrandsPageWrapper() {
  return (
    <Suspense fallback={<div className="p-6 text-muted-foreground">Loading brands...</div>}>
      <BrandsPage />
    </Suspense>
  );
}

function BrandsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [brands, setBrands] = useState<BrandAccount[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);

  const page = parseInt(searchParams.get("page") || "1");
  const limit = 25;
  const search = searchParams.get("search") || "";
  const sort = searchParams.get("sort") || "match_count";
  const order = searchParams.get("order") || "desc";
  const sectorFilter = searchParams.get("sector") || "";
  const relevanceFilter = searchParams.get("relevance") || "";
  const brandTypeFilter = searchParams.get("brand_type") || "";
  const minMatches = searchParams.get("min_matches") || "";
  const maxMatches = searchParams.get("max_matches") || "";

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectAll, setSelectAll] = useState(false);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [searchInput, setSearchInput] = useState(search);

  const buildUrl = useCallback((overrides: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const vals: Record<string, string | null> = {
      page: String(page), search, sort, order,
      sector: sectorFilter, relevance: relevanceFilter,
      brand_type: brandTypeFilter, min_matches: minMatches, max_matches: maxMatches,
      ...overrides,
    };
    for (const [k, v] of Object.entries(vals)) {
      if (v && v !== "") p.set(k, v);
    }
    return `/brands?${p.toString()}`;
  }, [page, search, sort, order, sectorFilter, relevanceFilter, brandTypeFilter, minMatches, maxMatches]);

  const fetchBrands = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      p.set("page", String(page));
      p.set("limit", String(limit));
      if (search) p.set("search", search);
      p.set("sort", sort);
      p.set("order", order);
      if (sectorFilter) p.set("sector", sectorFilter);
      if (relevanceFilter) p.set("relevance", relevanceFilter);
      if (brandTypeFilter) p.set("brand_type", brandTypeFilter);
      if (minMatches) p.set("min_matches", minMatches);
      if (maxMatches) p.set("max_matches", maxMatches);

      const res = await fetch(`/api/v1/brands?${p.toString()}`);
      const data: ApiResponse = await res.json();
      setBrands(data.data);
      setTotal(data.total);
      setTotalPages(data.totalPages);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [page, search, sort, order, sectorFilter, relevanceFilter, brandTypeFilter, minMatches, maxMatches]);

  useEffect(() => { fetchBrands(); }, [fetchBrands]);

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectAll) {
      setSelected(new Set());
      setSelectAll(false);
    } else {
      setSelected(new Set(brands.map(b => b.id)));
      setSelectAll(true);
    }
  };

  const bulkAction = async (action: string) => {
    if (selected.size === 0) return;
    setBulkLoading(true);
    try {
      const res = await fetch("/api/v1/brands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ids: Array.from(selected) }),
      });
      const data = await res.json();
      if (data.success) {
        setSelected(new Set());
        setSelectAll(false);
        fetchBrands();
      }
    } catch {
      // silently fail
    } finally {
      setBulkLoading(false);
    }
  };

  const handleSort = (col: string) => {
    const newOrder = sort === col && order === "desc" ? "asc" : "desc";
    router.push(buildUrl({ sort: col, order: newOrder, page: "1" }));
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    router.push(buildUrl({ search: searchInput || null, page: "1" }));
  };

  const SortIndicator = ({ col }: { col: string }) => {
    if (sort !== col) return null;
    return <span className="ml-1">{order === "asc" ? "↑" : "↓"}</span>;
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Brand Accounts</h1>
          <p className="text-sm text-muted-foreground">{total.toLocaleString()} brands</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={handleSearch} className="flex gap-1">
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search brands..."
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              className="pl-8 w-64"
            />
          </div>
          <Button type="submit" variant="secondary" size="sm">Search</Button>
        </form>

        <Select value={sectorFilter || "all"} onValueChange={v => router.push(buildUrl({ sector: v === "all" ? null : v, page: "1" }))}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Sector" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Sectors</SelectItem>
            {sectorOptions.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={relevanceFilter || "all"} onValueChange={v => router.push(buildUrl({ relevance: v === "all" ? null : v, page: "1" }))}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Relevance" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Relevance</SelectItem>
            <SelectItem value="relevant">Relevant</SelectItem>
            <SelectItem value="irrelevant">Irrelevant</SelectItem>
            <SelectItem value="needs_review">Needs Review</SelectItem>
          </SelectContent>
        </Select>

        <Select value={brandTypeFilter || "all"} onValueChange={v => router.push(buildUrl({ brand_type: v === "all" ? null : v, page: "1" }))}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Type" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="wholesale">Wholesale</SelectItem>
            <SelectItem value="own_store">Own Store</SelectItem>
            <SelectItem value="unknown">Unknown</SelectItem>
          </SelectContent>
        </Select>

        <Input
          type="number"
          placeholder="Min matches"
          value={minMatches}
          onChange={e => router.push(buildUrl({ min_matches: e.target.value || null, page: "1" }))}
          className="w-28"
        />
        <Input
          type="number"
          placeholder="Max matches"
          value={maxMatches}
          onChange={e => router.push(buildUrl({ max_matches: e.target.value || null, page: "1" }))}
          className="w-28"
        />

        {(sectorFilter || relevanceFilter || brandTypeFilter || minMatches || maxMatches || search) && (
          <Button variant="ghost" size="sm" onClick={() => router.push("/brands")}>
            <X className="h-4 w-4 mr-1" /> Clear
          </Button>
        )}
      </div>

      {/* Bulk actions */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 p-2 bg-muted rounded-md">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <Button size="sm" variant="outline" onClick={() => bulkAction("mark_relevant")} disabled={bulkLoading}>
            Mark Relevant
          </Button>
          <Button size="sm" variant="outline" onClick={() => bulkAction("mark_irrelevant")} disabled={bulkLoading}>
            Mark Irrelevant
          </Button>
          <Button size="sm" variant="outline" onClick={() => bulkAction("mark_needs_review")} disabled={bulkLoading}>
            Needs Review
          </Button>
          <Button size="sm" variant="destructive" onClick={() => bulkAction("dq_stores")} disabled={bulkLoading}>
            DQ All Stores
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setSelected(new Set()); setSelectAll(false); }}>
            Cancel
          </Button>
        </div>
      )}

      {/* Table */}
      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input type="checkbox" checked={selectAll} onChange={toggleSelectAll} className="rounded" />
              </TableHead>
              <TableHead className="cursor-pointer" onClick={() => handleSort("name")}>
                Name<SortIndicator col="name" />
              </TableHead>
              <TableHead>Website</TableHead>
              <TableHead className="cursor-pointer" onClick={() => handleSort("sector")}>
                Sector<SortIndicator col="sector" />
              </TableHead>
              <TableHead className="cursor-pointer" onClick={() => handleSort("relevance")}>
                Relevance<SortIndicator col="relevance" />
              </TableHead>
              <TableHead className="cursor-pointer" onClick={() => handleSort("brand_type")}>
                Type<SortIndicator col="brand_type" />
              </TableHead>
              <TableHead className="cursor-pointer text-right" onClick={() => handleSort("match_count")}>
                DB Matches<SortIndicator col="match_count" />
              </TableHead>
              <TableHead className="cursor-pointer text-right" onClick={() => handleSort("us_locations")}>
                US Locs<SortIndicator col="us_locations" />
              </TableHead>
              <TableHead className="cursor-pointer text-right" onClick={() => handleSort("total_locations")}>
                Total Locs<SortIndicator col="total_locations" />
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
            ) : brands.length === 0 ? (
              <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground">No brands found</TableCell></TableRow>
            ) : (
              brands.map(brand => (
                <TableRow key={brand.id} className="cursor-pointer hover:bg-muted/50">
                  <TableCell onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(brand.id)}
                      onChange={() => toggleSelect(brand.id)}
                      className="rounded"
                    />
                  </TableCell>
                  <TableCell>
                    <Link href={`/brands/${brand.id}`} className="font-medium hover:underline">
                      {brand.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {brand.website ? (
                      <a href={brand.website.startsWith("http") ? brand.website : `https://${brand.website}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline flex items-center gap-1 text-sm" onClick={e => e.stopPropagation()}>
                        {brand.website.replace(/^https?:\/\//, "").slice(0, 30)}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <span className="text-muted-foreground text-sm">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {brand.sector ? (
                      <Badge variant="secondary" className="text-xs">{brand.sector}</Badge>
                    ) : <span className="text-muted-foreground text-sm">—</span>}
                  </TableCell>
                  <TableCell>
                    <Badge className={`text-xs ${relevanceColors[brand.relevance] || ""}`}>
                      {brand.relevance.replace("_", " ")}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm">{brandTypeLabels[brand.brand_type] || brand.brand_type}</span>
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {brand.match_count}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {brand.us_locations.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {brand.total_locations.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {page} of {totalPages} ({total.toLocaleString()} brands)
          </p>
          <div className="flex gap-1">
            <Button
              variant="outline" size="sm"
              disabled={page <= 1}
              onClick={() => router.push(buildUrl({ page: String(page - 1) }))}
            >
              <ChevronLeft className="h-4 w-4" /> Prev
            </Button>
            <Button
              variant="outline" size="sm"
              disabled={page >= totalPages}
              onClick={() => router.push(buildUrl({ page: String(page + 1) }))}
            >
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
