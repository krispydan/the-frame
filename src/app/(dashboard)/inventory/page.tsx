"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import {
  Package, AlertTriangle, XCircle, TrendingUp, Search, ArrowUpDown,
  ArrowUp, ArrowDown, Filter, ChevronRight,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

type InventoryItem = {
  id: string;
  sku_id: string;
  sku: string;
  product_name: string;
  color_name: string;
  sku_prefix: string;
  factory_name: string;
  category: string;
  quantity: number;
  reserved_quantity: number;
  reorder_point: number;
  sell_through_weekly: number;
  days_of_stock: number;
  needs_reorder: number;
  cost_price: number;
  wholesale_price: number;
  retail_price: number;
};

type Summary = {
  totalSkus: number;
  inStock: number;
  lowStock: number;
  outOfStock: number;
  needsReorder: number;
};

const VELOCITY_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  fast: { bg: "bg-green-100", text: "text-green-700", label: "Fast" },
  normal: { bg: "bg-gray-100", text: "text-gray-700", label: "Normal" },
  slow: { bg: "bg-orange-100", text: "text-orange-700", label: "Slow" },
  dead: { bg: "bg-red-100", text: "text-red-700", label: "Dead" },
  out: { bg: "bg-red-200", text: "text-red-800", label: "Out" },
};

function getVelocity(item: InventoryItem) {
  if (item.quantity === 0) return "out";
  if (item.sell_through_weekly >= 10) return "fast";
  if (item.sell_through_weekly >= 3) return "normal";
  if (item.sell_through_weekly >= 0.5) return "slow";
  return "dead";
}

function getFactorySeries(sku: string): string {
  const match = sku.match(/^(JX\d)/);
  return match ? match[1] : "?";
}

const FACTORY_LABELS: Record<string, string> = {
  JX1: "Taga",
  JX2: "Huide",
  JX3: "Geya",
  JX4: "Brilliant",
};

type SortKey = "days_of_stock" | "sell_through" | "quantity" | "sku";
type SortDir = "asc" | "desc";

export default function InventoryPage() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [summary, setSummary] = useState<Summary>({ totalSkus: 0, inStock: 0, lowStock: 0, outOfStock: 0, needsReorder: 0 });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [factoryFilter, setFactoryFilter] = useState("all");
  const [stockFilter, setStockFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("days_of_stock");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  useEffect(() => {
    const timer = setTimeout(() => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (factoryFilter !== "all") params.set("factory", factoryFilter);
      if (stockFilter !== "all") params.set("stock", stockFilter);
      params.set("sortBy", sortKey);
      params.set("sortDir", sortDir);

      fetch(`/api/v1/inventory?${params}`)
        .then((r) => r.json())
        .then((data) => {
          setItems(data.items || []);
          setSummary(data.summary || summary);
          setLoading(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [search, factoryFilter, stockFilter, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "sell_through" ? "desc" : "asc");
    }
  }

  function SortIcon({ column }: { column: SortKey }) {
    if (sortKey !== column) return <ArrowUpDown className="h-3 w-3 ml-1 opacity-40" />;
    return sortDir === "asc"
      ? <ArrowUp className="h-3 w-3 ml-1 text-blue-600" />
      : <ArrowDown className="h-3 w-3 ml-1 text-blue-600" />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Inventory</h1>
          <p className="text-muted-foreground text-sm">Stock levels, sell-through velocity, and reorder alerts</p>
        </div>
        <Link href="/inventory/purchase-orders">
          <Button variant="outline" className="gap-2">
            Purchase Orders <ChevronRight className="h-4 w-4" />
          </Button>
        </Link>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setStockFilter("all")}>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2">
              <Package className="h-5 w-5 text-blue-600" />
              <div>
                <p className="text-2xl font-bold">{summary.totalSkus}</p>
                <p className="text-xs text-muted-foreground">Total SKUs</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setStockFilter("all")}>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-green-600" />
              <div>
                <p className="text-2xl font-bold">{summary.inStock}</p>
                <p className="text-xs text-muted-foreground">In Stock</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:shadow-md transition-shadow border-orange-200" onClick={() => setStockFilter("low")}>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-orange-600" />
              <div>
                <p className="text-2xl font-bold text-orange-600">{summary.lowStock}</p>
                <p className="text-xs text-muted-foreground">Low Stock</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:shadow-md transition-shadow border-red-200" onClick={() => setStockFilter("out")}>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-red-600" />
              <div>
                <p className="text-2xl font-bold text-red-600">{summary.outOfStock}</p>
                <p className="text-xs text-muted-foreground">Out of Stock</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:shadow-md transition-shadow border-yellow-200" onClick={() => setStockFilter("all")}>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-yellow-600" />
              <div>
                <p className="text-2xl font-bold text-yellow-600">{summary.needsReorder}</p>
                <p className="text-xs text-muted-foreground">Needs Reorder</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search SKU, product, color..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={factoryFilter} onValueChange={(v) => setFactoryFilter(v || "all")}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Factory" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Factories</SelectItem>
            <SelectItem value="JX1">JX1 — Taga</SelectItem>
            <SelectItem value="JX2">JX2 — Huide</SelectItem>
            <SelectItem value="JX3">JX3 — Geya</SelectItem>
            <SelectItem value="JX4">JX4 — Brilliant</SelectItem>
          </SelectContent>
        </Select>
        <Select value={stockFilter} onValueChange={(v) => setStockFilter(v || "all")}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Stock Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Stock</SelectItem>
            <SelectItem value="low">Low Stock</SelectItem>
            <SelectItem value="out">Out of Stock</SelectItem>
            <SelectItem value="overstocked">Overstocked</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="cursor-pointer" onClick={() => toggleSort("sku")}>
                    <span className="flex items-center">SKU <SortIcon column="sku" /></span>
                  </TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Color</TableHead>
                  <TableHead>Factory</TableHead>
                  <TableHead className="text-right cursor-pointer" onClick={() => toggleSort("quantity")}>
                    <span className="flex items-center justify-end">In Stock <SortIcon column="quantity" /></span>
                  </TableHead>
                  <TableHead className="text-right">Reserved</TableHead>
                  <TableHead className="text-right">Reorder Pt</TableHead>
                  <TableHead className="text-right cursor-pointer" onClick={() => toggleSort("sell_through")}>
                    <span className="flex items-center justify-end">Sell/Week <SortIcon column="sell_through" /></span>
                  </TableHead>
                  <TableHead className="text-right cursor-pointer" onClick={() => toggleSort("days_of_stock")}>
                    <span className="flex items-center justify-end">Days Left <SortIcon column="days_of_stock" /></span>
                  </TableHead>
                  <TableHead>Velocity</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={11} className="text-center py-8 text-muted-foreground">
                      Loading inventory...
                    </TableCell>
                  </TableRow>
                ) : items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={11} className="text-center py-8 text-muted-foreground">
                      No items found
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((item) => {
                    const velocity = getVelocity(item);
                    const vc = VELOCITY_COLORS[velocity];
                    const isOut = item.quantity === 0;
                    const isLow = item.quantity > 0 && item.quantity <= item.reorder_point;
                    const daysDisplay = item.days_of_stock >= 9999 ? "∞" : Math.round(item.days_of_stock);
                    const series = getFactorySeries(item.sku);

                    return (
                      <TableRow
                        key={item.id}
                        className={isOut ? "bg-red-50" : isLow ? "bg-orange-50" : ""}
                      >
                        <TableCell className="font-mono text-sm font-medium">{item.sku}</TableCell>
                        <TableCell className="max-w-[180px] truncate">{item.product_name}</TableCell>
                        <TableCell>{item.color_name}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {series} · {FACTORY_LABELS[series] || series}
                          </Badge>
                        </TableCell>
                        <TableCell className={`text-right font-medium ${isOut ? "text-red-600" : isLow ? "text-orange-600" : ""}`}>
                          {item.quantity}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">{item.reserved_quantity}</TableCell>
                        <TableCell className="text-right text-muted-foreground">{item.reorder_point}</TableCell>
                        <TableCell className="text-right">{item.sell_through_weekly}/wk</TableCell>
                        <TableCell className={`text-right font-medium ${
                          isOut ? "text-red-600" : item.days_of_stock < 30 ? "text-orange-600" : item.days_of_stock < 60 ? "text-yellow-600" : ""
                        }`}>
                          {daysDisplay}
                        </TableCell>
                        <TableCell>
                          <Badge className={`${vc.bg} ${vc.text} border-0 text-xs`}>{vc.label}</Badge>
                        </TableCell>
                        <TableCell>
                          {item.needs_reorder ? (
                            <Badge className="bg-red-100 text-red-700 border-0 text-xs">Reorder</Badge>
                          ) : isOut ? (
                            <Badge className="bg-red-200 text-red-800 border-0 text-xs">OOS</Badge>
                          ) : isLow ? (
                            <Badge className="bg-orange-100 text-orange-700 border-0 text-xs">Low</Badge>
                          ) : (
                            <Badge className="bg-green-100 text-green-700 border-0 text-xs">OK</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
