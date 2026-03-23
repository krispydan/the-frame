"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import Link from "next/link";
import {
  Package, AlertTriangle, XCircle, TrendingUp, Search, ArrowUpDown,
  ArrowUp, ArrowDown, Filter, ChevronRight, RefreshCw, BarChart3,
  Check, X, Edit2, Loader2, TrendingDown, Minus, AlertCircle, Zap,
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

type ForecastItem = {
  skuId: string;
  sku: string;
  productName: string;
  colorName: string;
  factoryCode: string;
  currentStock: number;
  sellThrough30d: number;
  sellThrough60d: number;
  sellThrough90d: number;
  trendDirection: "accelerating" | "stable" | "decelerating";
  projectedWeeklyRate: number;
  projectedStockoutDate: string | null;
  daysUntilStockout: number;
  recommendedReorderQty: number;
  targetStockDays: number;
  urgencyLevel: "critical" | "urgent" | "watch" | "ok";
  seasonalFactor: number;
  notes: string;
};

type ForecastSummary = {
  total: number;
  critical: number;
  urgent: number;
  watch: number;
  ok: number;
  accelerating: number;
  decelerating: number;
};

const VELOCITY_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  fast: { bg: "bg-green-100", text: "text-green-700", label: "Fast" },
  normal: { bg: "bg-gray-100", text: "text-gray-700", label: "Normal" },
  slow: { bg: "bg-orange-100", text: "text-orange-700", label: "Slow" },
  dead: { bg: "bg-red-100", text: "text-red-700", label: "Dead" },
  out: { bg: "bg-red-200", text: "text-red-800", label: "Out" },
};

const URGENCY_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  critical: { bg: "bg-red-100", text: "text-red-700", dot: "bg-red-500" },
  urgent: { bg: "bg-orange-100", text: "text-orange-700", dot: "bg-orange-500" },
  watch: { bg: "bg-yellow-100", text: "text-yellow-700", dot: "bg-yellow-500" },
  ok: { bg: "bg-green-100", text: "text-green-700", dot: "bg-green-500" },
};

const TREND_ICONS: Record<string, { icon: typeof TrendingUp; color: string }> = {
  accelerating: { icon: TrendingUp, color: "text-green-600" },
  stable: { icon: Minus, color: "text-gray-500" },
  decelerating: { icon: TrendingDown, color: "text-red-600" },
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

// ── Inline Reorder Point Editor ──
function ReorderPointCell({ item, onSave }: { item: InventoryItem; onSave: (id: string, value: number) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(item.reorder_point));
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const parsed = parseInt(value);
    if (isNaN(parsed) || parsed < 0) return;
    setSaving(true);
    await onSave(item.id, parsed);
    setSaving(false);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <Input
          type="number"
          min={0}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-16 h-7 text-xs text-right"
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "Escape") setEditing(false);
          }}
          autoFocus
        />
        {saving ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <>
            <button onClick={handleSave} className="text-green-600 hover:text-green-800"><Check className="h-3 w-3" /></button>
            <button onClick={() => setEditing(false)} className="text-red-600 hover:text-red-800"><X className="h-3 w-3" /></button>
          </>
        )}
      </div>
    );
  }

  return (
    <button
      onClick={() => { setValue(String(item.reorder_point)); setEditing(true); }}
      className="group flex items-center gap-1 text-muted-foreground hover:text-foreground"
    >
      {item.reorder_point}
      <Edit2 className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
    </button>
  );
}

// ── Confidence Indicator ──
function ConfidenceBar({ level }: { level: "critical" | "urgent" | "watch" | "ok" }) {
  const confidenceMap = { ok: 85, watch: 65, urgent: 45, critical: 30 };
  const pct = confidenceMap[level];
  const color = pct >= 70 ? "bg-green-500" : pct >= 50 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground">{pct}%</span>
    </div>
  );
}

export default function InventoryPage() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [summary, setSummary] = useState<Summary>({ totalSkus: 0, inStock: 0, lowStock: 0, outOfStock: 0, needsReorder: 0 });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [factoryFilter, setFactoryFilter] = useState("all");
  const [stockFilter, setStockFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("days_of_stock");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // Sync state
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ success: boolean; message: string } | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);

  // Forecast state
  const [showForecast, setShowForecast] = useState(false);
  const [forecastItems, setForecastItems] = useState<ForecastItem[]>([]);
  const [forecastSummary, setForecastSummary] = useState<ForecastSummary | null>(null);
  const [forecastLoading, setForecastLoading] = useState(false);

  // Fetch sync status on mount
  useEffect(() => {
    fetch("/api/v1/inventory/sync")
      .then((r) => r.json())
      .then((data) => {
        if (data.lastSyncAt) setLastSyncAt(data.lastSyncAt);
      })
      .catch(() => {});
  }, []);

  const fetchInventory = useCallback(() => {
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
  }, [search, factoryFilter, stockFilter, sortKey, sortDir]);

  useEffect(() => {
    const timer = setTimeout(fetchInventory, 200);
    return () => clearTimeout(timer);
  }, [fetchInventory]);

  // ── Sync Handler ──
  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/v1/inventory/sync", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        const channelNames = (data.channels || [])
          .filter((c: any) => !c.error)
          .map((c: any) => c.channel)
          .join(", ");
        setSyncResult({
          success: true,
          message: `Synced ${data.synced} SKUs from ${channelNames || "Shopify"} (${data.changes?.length || 0} changed, ${data.movementsRecorded || 0} movements). ${data.alerts?.alertsCreated || 0} new alerts.`,
        });
        setLastSyncAt(data.syncedAt);
        fetchInventory(); // Refresh table
      } else {
        setSyncResult({ success: false, message: data.error || "Sync failed" });
      }
    } catch (e: any) {
      setSyncResult({ success: false, message: e.message || "Network error" });
    } finally {
      setSyncing(false);
    }
  }

  // ── Forecast Handler ──
  async function handleRunForecast() {
    setForecastLoading(true);
    try {
      const res = await fetch("/api/v1/inventory/forecast?targetDays=90");
      const data = await res.json();
      setForecastItems(data.forecast || []);
      setForecastSummary(data.summary || null);
      setShowForecast(true);
    } catch (e) {
      console.error("Forecast error:", e);
    } finally {
      setForecastLoading(false);
    }
  }

  // ── Reorder Point Save ──
  async function handleReorderPointSave(id: string, reorderPoint: number) {
    await fetch("/api/v1/inventory/reorder-point", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, reorderPoint }),
    });
    fetchInventory();
  }

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
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="gap-2"
            onClick={handleRunForecast}
            disabled={forecastLoading}
          >
            {forecastLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <BarChart3 className="h-4 w-4" />}
            {showForecast ? "Refresh Forecast" : "Run Forecast"}
          </Button>
          <Button
            variant="outline"
            className="gap-2"
            onClick={handleSync}
            disabled={syncing}
          >
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Sync Inventory
          </Button>
          <Link href="/inventory/purchase-orders">
            <Button variant="outline" className="gap-2">
              Purchase Orders <ChevronRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </div>

      {/* Sync Result Banner */}
      {syncResult && (
        <div className={`px-4 py-3 rounded-lg text-sm flex items-center gap-2 ${
          syncResult.success ? "bg-green-50 text-green-800 border border-green-200" : "bg-red-50 text-red-800 border border-red-200"
        }`}>
          {syncResult.success ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
          {syncResult.message}
          <button onClick={() => setSyncResult(null)} className="ml-auto"><X className="h-4 w-4" /></button>
        </div>
      )}

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

      {/* ── Forecast Section ── */}
      {showForecast && forecastSummary && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-purple-600" />
              Demand Forecast — Next 90 Days
            </h2>
            <Button variant="ghost" size="sm" onClick={() => setShowForecast(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Forecast Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Card className="border-red-200">
              <CardContent className="pt-3 pb-3">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-red-500" />
                  <div>
                    <p className="text-xl font-bold text-red-600">{forecastSummary.critical}</p>
                    <p className="text-xs text-muted-foreground">Critical</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card className="border-orange-200">
              <CardContent className="pt-3 pb-3">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-orange-500" />
                  <div>
                    <p className="text-xl font-bold text-orange-600">{forecastSummary.urgent}</p>
                    <p className="text-xs text-muted-foreground">Urgent</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card className="border-yellow-200">
              <CardContent className="pt-3 pb-3">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-yellow-500" />
                  <div>
                    <p className="text-xl font-bold text-yellow-600">{forecastSummary.watch}</p>
                    <p className="text-xs text-muted-foreground">Watch</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-3 pb-3">
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-green-600" />
                  <div>
                    <p className="text-xl font-bold text-green-600">{forecastSummary.accelerating}</p>
                    <p className="text-xs text-muted-foreground">Accelerating</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-3 pb-3">
                <div className="flex items-center gap-2">
                  <TrendingDown className="h-4 w-4 text-red-600" />
                  <div>
                    <p className="text-xl font-bold text-red-600">{forecastSummary.decelerating}</p>
                    <p className="text-xs text-muted-foreground">Decelerating</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Forecast Table */}
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead>Urgency</TableHead>
                      <TableHead className="text-right">Stock</TableHead>
                      <TableHead className="text-right">Projected/wk</TableHead>
                      <TableHead>Trend</TableHead>
                      <TableHead className="text-right">Stockout</TableHead>
                      <TableHead className="text-right">Reorder Qty</TableHead>
                      <TableHead>Confidence</TableHead>
                      <TableHead>Notes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {forecastItems.slice(0, 30).map((f) => {
                      const uc = URGENCY_COLORS[f.urgencyLevel];
                      const trend = TREND_ICONS[f.trendDirection];
                      const TrendIcon = trend.icon;
                      return (
                        <TableRow key={f.skuId} className={f.urgencyLevel === "critical" ? "bg-red-50" : f.urgencyLevel === "urgent" ? "bg-orange-50" : ""}>
                          <TableCell className="font-mono text-sm font-medium">{f.sku}</TableCell>
                          <TableCell className="max-w-[160px] truncate">
                            {f.productName}
                            {f.colorName && <span className="text-muted-foreground"> — {f.colorName}</span>}
                          </TableCell>
                          <TableCell>
                            <Badge className={`${uc.bg} ${uc.text} border-0 text-xs capitalize`}>
                              {f.urgencyLevel}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right font-medium">{f.currentStock}</TableCell>
                          <TableCell className="text-right">{f.projectedWeeklyRate}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <TrendIcon className={`h-3.5 w-3.5 ${trend.color}`} />
                              <span className={`text-xs ${trend.color}`}>{f.trendDirection}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            {f.projectedStockoutDate ? (
                              <span className={f.daysUntilStockout < 30 ? "text-red-600 font-medium" : f.daysUntilStockout < 60 ? "text-orange-600" : ""}>
                                {f.daysUntilStockout}d
                              </span>
                            ) : (
                              <span className="text-muted-foreground">∞</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {f.recommendedReorderQty > 0 ? f.recommendedReorderQty : "—"}
                          </TableCell>
                          <TableCell>
                            <ConfidenceBar level={f.urgencyLevel} />
                          </TableCell>
                          <TableCell className="max-w-[200px] text-xs text-muted-foreground truncate">
                            {f.notes || "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

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
                        <TableCell className="font-mono text-sm font-medium">
                          <div className="flex items-center gap-1.5">
                            {item.sku}
                            {isOut && <Badge className="bg-red-500 text-white border-0 text-[10px] px-1 py-0">OOS</Badge>}
                            {isLow && !isOut && <Badge className="bg-orange-500 text-white border-0 text-[10px] px-1 py-0">LOW</Badge>}
                          </div>
                        </TableCell>
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
                        <TableCell className="text-right">
                          <ReorderPointCell item={item} onSave={handleReorderPointSave} />
                        </TableCell>
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
