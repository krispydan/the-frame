"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import Link from "next/link";
import {
  Search, Package, LayoutGrid, List, Filter, ChevronDown, Image as ImageIcon,
  CheckSquare, XSquare, Download, MoreHorizontal, Plus, Upload, Loader2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { FACTORY_MAP } from "@/modules/catalog/schema";

type Product = {
  id: string;
  skuPrefix: string | null;
  name: string | null;
  category: string | null;
  factoryName: string | null;
  wholesalePrice: number | null;
  retailPrice: number | null;
  status: string | null;
  variantCount: number;
  imageCount: number;
  completeness: number;
};

const STATUS_COLORS: Record<string, string> = {
  intake: "bg-gray-100 text-gray-700",
  processing: "bg-blue-100 text-blue-700",
  review: "bg-yellow-100 text-yellow-700",
  approved: "bg-green-100 text-green-700",
  published: "bg-purple-100 text-purple-700",
};

const FACTORY_COLORS: Record<string, string> = {
  JX1: "bg-red-100 text-red-700",
  JX2: "bg-orange-100 text-orange-700",
  JX3: "bg-teal-100 text-teal-700",
  JX4: "bg-indigo-100 text-indigo-700",
};

function getFactorySeries(skuPrefix: string | null): string | null {
  if (!skuPrefix) return null;
  const match = skuPrefix.match(/^(JX\d)/);
  return match ? match[1] : null;
}

type SortKey = "name" | "skuPrefix" | "status" | "variantCount" | "completeness" | "retailPrice";
type SortDir = "asc" | "desc";

export default function CatalogPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [factoryFilter, setFactoryFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [hasImagesFilter, setHasImagesFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("skuPrefix");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  useEffect(() => {
    const timer = setTimeout(() => {
      fetch(`/api/v1/catalog/products?search=${encodeURIComponent(search)}&withStats=true`)
        .then((r) => r.json())
        .then((data) => {
          setProducts(data.products || []);
          setLoading(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [search]);

  const filtered = useMemo(() => {
    let result = products;
    if (statusFilter !== "all") result = result.filter((p) => p.status === statusFilter);
    if (factoryFilter !== "all") result = result.filter((p) => getFactorySeries(p.skuPrefix) === factoryFilter);
    if (categoryFilter !== "all") result = result.filter((p) => p.category === categoryFilter);
    if (hasImagesFilter === "yes") result = result.filter((p) => p.imageCount > 0);
    if (hasImagesFilter === "no") result = result.filter((p) => p.imageCount === 0);

    result = [...result].sort((a, b) => {
      const aVal = a[sortKey] ?? "";
      const bVal = b[sortKey] ?? "";
      const cmp = typeof aVal === "number" && typeof bVal === "number" ? aVal - bVal : String(aVal).localeCompare(String(bVal));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return result;
  }, [products, statusFilter, factoryFilter, categoryFilter, hasImagesFilter, sortKey, sortDir]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((p) => p.id)));
    }
  }, [filtered, selected.size]);

  const handleBulkStatus = async (status: string) => {
    await fetch("/api/v1/catalog/products/bulk", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [...selected], status }),
    });
    setSelected(new Set());
    // Refresh
    setLoading(true);
    const r = await fetch(`/api/v1/catalog/products?search=${encodeURIComponent(search)}&withStats=true`);
    const data = await r.json();
    setProducts(data.products || []);
    setLoading(false);
  };

  const [pushingToShopify, setPushingToShopify] = useState(false);
  const [shopifyResult, setShopifyResult] = useState<{ created: number; updated: number; errors: number } | null>(null);

  const handleShopifyPush = async (stores: string[]) => {
    setPushingToShopify(true);
    setShopifyResult(null);
    try {
      const res = await fetch("/api/v1/catalog/shopify-push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: [...selected], stores }),
      });
      const data = await res.json();
      if (!res.ok) {
        setShopifyResult({ created: 0, updated: 0, errors: 1 });
      } else {
        setShopifyResult({ created: data.created, updated: data.updated, errors: data.errors });
      }
    } catch {
      setShopifyResult({ created: 0, updated: 0, errors: 1 });
    } finally {
      setPushingToShopify(false);
    }
  };

  const stats = useMemo(() => ({
    total: products.length,
    approved: products.filter((p) => p.status === "approved").length,
    review: products.filter((p) => p.status === "review").length,
    avgCompleteness: products.length ? Math.round(products.reduce((sum, p) => sum + (p.completeness || 0), 0) / products.length) : 0,
  }), [products]);

  const sortHeader = (key: SortKey, label: string) => (
    <TableHead
      className="cursor-pointer select-none hover:bg-muted/50"
      onClick={() => { setSortKey(key); setSortDir(sortKey === key && sortDir === "asc" ? "desc" : "asc"); }}
    >
      {label} {sortKey === key && (sortDir === "asc" ? "↑" : "↓")}
    </TableHead>
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Catalog</h1>
          <p className="text-muted-foreground">{stats.total} products · {stats.approved} approved · {stats.avgCompleteness}% avg completeness</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/catalog/intake">
            <Button><Plus className="h-4 w-4 mr-2" />Add Product</Button>
          </Link>
          <Link href="/catalog/export">
            <Button variant="outline"><Download className="h-4 w-4 mr-2" />Export</Button>
          </Link>
          <Button variant={view === "grid" ? "default" : "outline"} size="icon" onClick={() => setView("grid")}><LayoutGrid className="h-4 w-4" /></Button>
          <Button variant={view === "list" ? "default" : "outline"} size="icon" onClick={() => setView("list")}><List className="h-4 w-4" /></Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search by name or SKU..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-10" />
        </div>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "all")}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="intake">Intake</SelectItem>
            <SelectItem value="processing">Processing</SelectItem>
            <SelectItem value="review">Review</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="published">Published</SelectItem>
          </SelectContent>
        </Select>
        <Select value={factoryFilter} onValueChange={(v) => setFactoryFilter(v ?? "all")}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="Factory" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Factories</SelectItem>
            <SelectItem value="JX1">JX1 · TAGA</SelectItem>
            <SelectItem value="JX2">JX2 · HUIDE</SelectItem>
            <SelectItem value="JX3">JX3 · GEYA</SelectItem>
            <SelectItem value="JX4">JX4 · BRILLIANT</SelectItem>
          </SelectContent>
        </Select>
        <Select value={categoryFilter} onValueChange={(v) => setCategoryFilter(v ?? "all")}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="Category" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            <SelectItem value="sunglasses">Sunglasses</SelectItem>
            <SelectItem value="optical">Optical</SelectItem>
            <SelectItem value="reading">Reading</SelectItem>
          </SelectContent>
        </Select>
        <Select value={hasImagesFilter} onValueChange={(v) => setHasImagesFilter(v ?? "all")}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="Images" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="yes">Has Images</SelectItem>
            <SelectItem value="no">No Images</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Bulk actions */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <DropdownMenu>
            <DropdownMenuTrigger>
              <Button variant="outline" size="sm">Change Status <ChevronDown className="ml-1 h-3 w-3" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {["intake", "processing", "review", "approved", "published"].map((s) => (
                <DropdownMenuItem key={s} onClick={() => handleBulkStatus(s)}>{s}</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger>
              <Button variant="outline" size="sm" disabled={pushingToShopify}>
                {pushingToShopify ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Upload className="mr-1 h-3 w-3" />}
                Push to Shopify <ChevronDown className="ml-1 h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => handleShopifyPush(["dtc"])}>DTC Store</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleShopifyPush(["wholesale"])}>Wholesale Store</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => handleShopifyPush(["dtc", "wholesale"])}>Both Stores</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Link href={`/catalog/export?ids=${[...selected].join(",")}`}>
            <Button variant="outline" size="sm">
              <Download className="mr-1 h-3 w-3" /> Export Selected
            </Button>
          </Link>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
          {shopifyResult && (
            <span className={`text-xs ${shopifyResult.errors > 0 ? "text-red-600" : "text-green-600"}`}>
              {shopifyResult.created > 0 && `${shopifyResult.created} created`}
              {shopifyResult.created > 0 && shopifyResult.updated > 0 && ", "}
              {shopifyResult.updated > 0 && `${shopifyResult.updated} updated`}
              {shopifyResult.errors > 0 && ` (${shopifyResult.errors} errors)`}
            </span>
          )}
        </div>
      )}

      {loading ? (
        <div className="text-muted-foreground">Loading...</div>
      ) : view === "grid" ? (
        /* Grid View */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">
          {filtered.map((product) => {
            const series = getFactorySeries(product.skuPrefix);
            return (
              <div key={product.id} className="relative group">
                <div className="absolute top-2 left-2 z-10" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={selected.has(product.id)}
                    onCheckedChange={() => toggleSelect(product.id)}
                    className="opacity-0 group-hover:opacity-100 data-[state=checked]:opacity-100 transition-opacity bg-white"
                  />
                </div>
                <Link href={`/catalog/${product.skuPrefix}`}>
                  <Card className={`hover:shadow-md transition-shadow cursor-pointer h-full ${selected.has(product.id) ? "ring-2 ring-primary" : ""}`}>
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="text-base leading-tight">{product.name || product.skuPrefix}</CardTitle>
                        <Badge variant="secondary" className={STATUS_COLORS[product.status || "intake"]}>{product.status}</Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Package className="h-3.5 w-3.5" />
                        <span className="font-mono">{product.skuPrefix}</span>
                        {series && (
                          <Badge variant="outline" className={`text-xs ${FACTORY_COLORS[series] || ""}`}>
                            {series} · {FACTORY_MAP[series] || ""}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">{product.variantCount} variant{product.variantCount !== 1 ? "s" : ""}</span>
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <ImageIcon className="h-3 w-3" />
                          <span>{product.imageCount}</span>
                        </div>
                      </div>
                      <div className="space-y-1">
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">Completeness</span>
                          <span>{product.completeness}%</span>
                        </div>
                        <Progress value={product.completeness} className="h-1.5" />
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              </div>
            );
          })}
        </div>
      ) : (
        /* List View */
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox checked={selected.size === filtered.length && filtered.length > 0} onCheckedChange={toggleAll} />
                  </TableHead>
                  {sortHeader("skuPrefix", "SKU")}
                  {sortHeader("name", "Name")}
                  <TableHead>Factory</TableHead>
                  <TableHead>Category</TableHead>
                  {sortHeader("variantCount", "Variants")}
                  <TableHead>Images</TableHead>
                  {sortHeader("retailPrice", "Retail")}
                  {sortHeader("completeness", "Complete")}
                  {sortHeader("status", "Status")}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((product) => {
                  const series = getFactorySeries(product.skuPrefix);
                  return (
                    <TableRow key={product.id} className={selected.has(product.id) ? "bg-primary/5" : ""}>
                      <TableCell><Checkbox checked={selected.has(product.id)} onCheckedChange={() => toggleSelect(product.id)} /></TableCell>
                      <TableCell className="font-mono text-sm">
                        <Link href={`/catalog/${product.skuPrefix}`} className="hover:underline">{product.skuPrefix}</Link>
                      </TableCell>
                      <TableCell>
                        <Link href={`/catalog/${product.skuPrefix}`} className="hover:underline font-medium">{product.name || "—"}</Link>
                      </TableCell>
                      <TableCell>
                        {series && <Badge variant="outline" className={`text-xs ${FACTORY_COLORS[series] || ""}`}>{series}</Badge>}
                      </TableCell>
                      <TableCell className="capitalize">{product.category || "—"}</TableCell>
                      <TableCell>{product.variantCount}</TableCell>
                      <TableCell>{product.imageCount}</TableCell>
                      <TableCell>{product.retailPrice ? `$${product.retailPrice.toFixed(2)}` : "—"}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Progress value={product.completeness} className="h-1.5 w-16" />
                          <span className="text-xs">{product.completeness}%</span>
                        </div>
                      </TableCell>
                      <TableCell><Badge variant="secondary" className={STATUS_COLORS[product.status || "intake"]}>{product.status}</Badge></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
