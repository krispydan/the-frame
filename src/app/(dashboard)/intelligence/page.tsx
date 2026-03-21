"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TrendingUp, TrendingDown, Minus, BarChart3, RefreshCw, ArrowUpDown, AlertTriangle, Package } from "lucide-react";

// ── Types ──

interface SellThroughItem {
  skuId: string;
  sku: string;
  productName: string;
  colorName: string;
  factoryCode: string;
  currentStock: number;
  reservedStock: number;
  availableStock: number;
  sellThroughWeekly: number;
  sellThroughDaily: number;
  daysOfStock: number;
  reorderDate: string | null;
  needsReorder: boolean;
  productionLeadDays: number;
  transitLeadDays: number;
  totalLeadDays: number;
  velocity: "fast" | "normal" | "slow" | "dead";
}

interface SellThroughData {
  items: SellThroughItem[];
  count: number;
  windowDays: number;
  summary: {
    fastMovers: number;
    normalMovers: number;
    slowMovers: number;
    deadStock: number;
    needsReorder: number;
    outOfStock: number;
  };
}

type SortKey = "sku" | "productName" | "sellThroughWeekly" | "daysOfStock" | "currentStock" | "availableStock" | "velocity";
type SortDir = "asc" | "desc";

function fmt(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

const velocityBadge = (v: string) => {
  switch (v) {
    case "fast": return <Badge className="bg-green-100 text-green-800">Fast</Badge>;
    case "normal": return <Badge variant="secondary">Normal</Badge>;
    case "slow": return <Badge className="bg-orange-100 text-orange-800">Slow</Badge>;
    case "dead": return <Badge variant="destructive">Dead</Badge>;
    default: return <Badge variant="outline">{v}</Badge>;
  }
};

const velocityOrder = { fast: 0, normal: 1, slow: 2, dead: 3 };

export default function IntelligencePage() {
  const [data, setData] = useState<SellThroughData | null>(null);
  const [loading, setLoading] = useState(true);
  const [windowDays, setWindowDays] = useState(30);
  const [sortKey, setSortKey] = useState<SortKey>("sellThroughWeekly");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [filterVelocity, setFilterVelocity] = useState<string>("all");

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/inventory/sell-through?window=${windowDays}`);
      const json = await res.json();
      setData(json);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [windowDays]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  };

  const sortIcon = (key: SortKey) => {
    if (sortKey !== key) return <ArrowUpDown className="h-3 w-3 text-muted-foreground/50" />;
    return <ArrowUpDown className={`h-3 w-3 ${sortDir === "asc" ? "rotate-180" : ""}`} />;
  };

  const items = data?.items || [];
  const summary = data?.summary;

  // Filter
  const filtered = filterVelocity === "all" ? items : items.filter((i) => i.velocity === filterVelocity);

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case "sku": cmp = a.sku.localeCompare(b.sku); break;
      case "productName": cmp = a.productName.localeCompare(b.productName); break;
      case "sellThroughWeekly": cmp = a.sellThroughWeekly - b.sellThroughWeekly; break;
      case "daysOfStock": cmp = a.daysOfStock - b.daysOfStock; break;
      case "currentStock": cmp = a.currentStock - b.currentStock; break;
      case "availableStock": cmp = a.availableStock - b.availableStock; break;
      case "velocity": cmp = velocityOrder[a.velocity] - velocityOrder[b.velocity]; break;
    }
    return sortDir === "asc" ? cmp : -cmp;
  });

  // Best / worst sellers
  const bestSellers = [...items].sort((a, b) => b.sellThroughWeekly - a.sellThroughWeekly).slice(0, 5);
  const deadStock = items.filter((i) => i.velocity === "dead");
  const needsReorder = items.filter((i) => i.needsReorder);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><BarChart3 className="h-6 w-6" /> Product Intelligence</h1>
          <p className="text-muted-foreground">Sell-through analytics from real order &amp; inventory data</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={windowDays}
            onChange={(e) => setWindowDays(parseInt(e.target.value))}
            className="rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={60}>Last 60 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <button onClick={loadData} disabled={loading} className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">Total SKUs</CardTitle></CardHeader>
          <CardContent><p className="text-xl font-bold">{data?.count || 0}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">Fast Movers</CardTitle></CardHeader>
          <CardContent><p className="text-xl font-bold text-green-600">{summary?.fastMovers || 0}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">Normal</CardTitle></CardHeader>
          <CardContent><p className="text-xl font-bold">{summary?.normalMovers || 0}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">Slow</CardTitle></CardHeader>
          <CardContent><p className="text-xl font-bold text-orange-600">{summary?.slowMovers || 0}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">Dead Stock</CardTitle></CardHeader>
          <CardContent><p className="text-xl font-bold text-red-600">{summary?.deadStock || 0}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">Needs Reorder</CardTitle></CardHeader>
          <CardContent><p className="text-xl font-bold text-amber-600">{summary?.needsReorder || 0}</p></CardContent>
        </Card>
      </div>

      <Tabs defaultValue="sell-through">
        <TabsList>
          <TabsTrigger value="sell-through">Sell-Through</TabsTrigger>
          <TabsTrigger value="best-worst">Best &amp; Worst Sellers</TabsTrigger>
          <TabsTrigger value="dead-stock">Dead Stock</TabsTrigger>
          <TabsTrigger value="reorder">Reorder Alerts</TabsTrigger>
        </TabsList>

        {/* ── Sell-Through Table ── */}
        <TabsContent value="sell-through">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Velocity per SKU — {windowDays}-day window</CardTitle>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Filter:</span>
                  {["all", "fast", "normal", "slow", "dead"].map((v) => (
                    <button
                      key={v}
                      onClick={() => setFilterVelocity(v)}
                      className={`text-xs px-2 py-1 rounded ${filterVelocity === v ? "bg-primary text-primary-foreground" : "border hover:bg-muted"}`}
                    >
                      {v === "all" ? "All" : v.charAt(0).toUpperCase() + v.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="cursor-pointer" onClick={() => handleSort("sku")}>
                        <span className="flex items-center gap-1">SKU {sortIcon("sku")}</span>
                      </TableHead>
                      <TableHead className="cursor-pointer" onClick={() => handleSort("productName")}>
                        <span className="flex items-center gap-1">Product {sortIcon("productName")}</span>
                      </TableHead>
                      <TableHead className="cursor-pointer text-right" onClick={() => handleSort("currentStock")}>
                        <span className="flex items-center gap-1 justify-end">Stock {sortIcon("currentStock")}</span>
                      </TableHead>
                      <TableHead className="cursor-pointer text-right" onClick={() => handleSort("availableStock")}>
                        <span className="flex items-center gap-1 justify-end">Available {sortIcon("availableStock")}</span>
                      </TableHead>
                      <TableHead className="cursor-pointer text-right" onClick={() => handleSort("sellThroughWeekly")}>
                        <span className="flex items-center gap-1 justify-end">Units/Week {sortIcon("sellThroughWeekly")}</span>
                      </TableHead>
                      <TableHead className="cursor-pointer text-right" onClick={() => handleSort("daysOfStock")}>
                        <span className="flex items-center gap-1 justify-end">Days of Supply {sortIcon("daysOfStock")}</span>
                      </TableHead>
                      <TableHead>Reorder By</TableHead>
                      <TableHead className="cursor-pointer" onClick={() => handleSort("velocity")}>
                        <span className="flex items-center gap-1">Velocity {sortIcon("velocity")}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sorted.map((item) => (
                      <TableRow key={item.skuId} className={item.needsReorder ? "bg-amber-50 dark:bg-amber-950/20" : ""}>
                        <TableCell className="font-mono text-sm">{item.sku}</TableCell>
                        <TableCell>
                          <div className="font-medium">{item.productName}</div>
                          <div className="text-xs text-muted-foreground">{item.colorName}</div>
                        </TableCell>
                        <TableCell className="text-right">{item.currentStock}</TableCell>
                        <TableCell className="text-right">
                          {item.availableStock}
                          {item.reservedStock > 0 && (
                            <span className="text-xs text-muted-foreground ml-1">({item.reservedStock} rsv)</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-medium">{item.sellThroughWeekly}</TableCell>
                        <TableCell className="text-right">
                          <span className={
                            item.daysOfStock < 14 ? "text-red-600 font-bold" :
                            item.daysOfStock < 30 ? "text-orange-600 font-medium" :
                            item.daysOfStock > 9000 ? "text-muted-foreground" : ""
                          }>
                            {item.daysOfStock > 9000 ? "∞" : `${Math.round(item.daysOfStock)}d`}
                          </span>
                        </TableCell>
                        <TableCell>
                          {item.reorderDate ? (
                            <span className={item.needsReorder ? "text-red-600 font-medium" : "text-muted-foreground"}>
                              {item.reorderDate}
                              {item.needsReorder && " ⚠"}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>{velocityBadge(item.velocity)}</TableCell>
                      </TableRow>
                    ))}
                    {sorted.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                          No items found
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Best & Worst Sellers ── */}
        <TabsContent value="best-worst">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-green-500" /> Top 5 Best Sellers
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {bestSellers.map((item, i) => (
                    <div key={item.skuId} className="flex items-center gap-3">
                      <span className="text-lg font-bold text-muted-foreground w-6">#{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{item.productName} — {item.colorName}</div>
                        <div className="text-xs text-muted-foreground">{item.sku}</div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold">{item.sellThroughWeekly}/wk</div>
                        <div className="text-xs text-muted-foreground">{item.availableStock} in stock</div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingDown className="h-4 w-4 text-red-500" /> Worst Performers
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {[...items].sort((a, b) => a.sellThroughWeekly - b.sellThroughWeekly).slice(0, 5).map((item, i) => (
                    <div key={item.skuId} className="flex items-center gap-3">
                      <span className="text-lg font-bold text-muted-foreground w-6">#{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{item.productName} — {item.colorName}</div>
                        <div className="text-xs text-muted-foreground">{item.sku}</div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold">{item.sellThroughWeekly}/wk</div>
                        {velocityBadge(item.velocity)}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── Dead Stock ── */}
        <TabsContent value="dead-stock">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Package className="h-4 w-4 text-red-500" /> Dead Stock Identification
              </CardTitle>
              <p className="text-sm text-muted-foreground">SKUs with zero or near-zero sell-through in the {windowDays}-day window</p>
            </CardHeader>
            <CardContent>
              {deadStock.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">No dead stock identified 🎉</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Stock on Hand</TableHead>
                      <TableHead className="text-right">Units/Week</TableHead>
                      <TableHead className="text-right">Est. Value Tied Up</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {deadStock.map((item) => (
                      <TableRow key={item.skuId}>
                        <TableCell className="font-mono text-sm">{item.sku}</TableCell>
                        <TableCell>
                          <div className="font-medium">{item.productName}</div>
                          <div className="text-xs text-muted-foreground">{item.colorName}</div>
                        </TableCell>
                        <TableCell className="text-right">{item.currentStock}</TableCell>
                        <TableCell className="text-right text-red-600">{item.sellThroughWeekly}</TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          ~{fmt(item.currentStock * 3.5)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Reorder Alerts ── */}
        <TabsContent value="reorder">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" /> Reorder Alerts
              </CardTitle>
              <p className="text-sm text-muted-foreground">SKUs that need to be reordered now based on lead time + current velocity</p>
            </CardHeader>
            <CardContent>
              {needsReorder.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">All SKUs are sufficiently stocked ✓</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Available</TableHead>
                      <TableHead className="text-right">Days of Supply</TableHead>
                      <TableHead className="text-right">Lead Time</TableHead>
                      <TableHead>Reorder By</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {needsReorder.sort((a, b) => a.daysOfStock - b.daysOfStock).map((item) => (
                      <TableRow key={item.skuId} className="bg-amber-50 dark:bg-amber-950/20">
                        <TableCell className="font-mono text-sm">{item.sku}</TableCell>
                        <TableCell>
                          <div className="font-medium">{item.productName}</div>
                          <div className="text-xs text-muted-foreground">{item.colorName}</div>
                        </TableCell>
                        <TableCell className="text-right">{item.availableStock}</TableCell>
                        <TableCell className="text-right">
                          <span className={item.daysOfStock < 14 ? "text-red-600 font-bold" : "text-orange-600"}>
                            {Math.round(item.daysOfStock)}d
                          </span>
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">{item.totalLeadDays}d</TableCell>
                        <TableCell className="text-red-600 font-medium">{item.reorderDate} ⚠</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
