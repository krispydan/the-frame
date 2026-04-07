"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  TrendingUp, TrendingDown, BarChart3, RefreshCw, ArrowUpDown,
  AlertTriangle, Package, Activity, FileText, Zap, Heart, ShoppingCart, Kanban, Target,
} from "lucide-react";

// ── Types ──

interface ProductTrend {
  sku: string;
  productName: string;
  colorName: string | null;
  currentPeriodUnits: number;
  priorPeriodUnits: number;
  currentPeriodRevenue: number;
  growthRate: number;
  momentumScore: number;
  direction: "up" | "down" | "flat";
}

interface ChannelTrend {
  channel: string;
  currentPeriodOrders: number;
  priorPeriodOrders: number;
  currentPeriodRevenue: number;
  priorPeriodRevenue: number;
  growthRate: number;
}

interface TrendData {
  trending_up: ProductTrend[];
  trending_down: ProductTrend[];
  flat: ProductTrend[];
  dead_stock: { sku: string; name: string; days_since_sale: number }[];
  channel_trends: ChannelTrend[];
  periodDays: number;
  generatedAt: string;
}

interface HealthComponent {
  score: number;
  label: string;
  trend: "up" | "down" | "flat";
}

interface BusinessHealth {
  overall: number;
  status: string;
  color: "green" | "yellow" | "red";
  components: {
    pipeline: HealthComponent;
    inventory: HealthComponent;
    customers: HealthComponent;
    finance: HealthComponent;
  };
}

interface ReportData {
  id: string;
  period: string;
  dateRange: { from: string; to: string };
  revenue: { total: number; priorTotal: number; changePercent: number };
  orders: { count: number; priorCount: number; avgOrderValue: number };
  topProducts: { sku: string; name: string; units: number; revenue: number }[];
  channelBreakdown: { channel: string; orders: number; revenue: number; percent: number }[];
  healthScore: number;
  healthStatus: string;
  generatedAt: string;
  markdown: string;
}

interface PipelineStage {
  stage: string;
  count: number;
  total_value: number;
  avg_days: number;
}

interface PipelineFunnel {
  stage: string;
  count: number;
  rate: number;
}

interface PipelineData {
  byStage: PipelineStage[];
  funnel: PipelineFunnel[];
  stageTransitions: { from_stage: string; to_stage: string; transition_count: number; avg_days_between: number }[];
  summary: {
    totalDeals: number;
    dealsCreatedLast30: number;
    dealsWonLast30: number;
    dealsLostLast30: number;
    winRate: number;
  };
}

interface SellThroughItem {
  sku: string;
  productName: string;
  colorName: string | null;
  currentStock: number;
  unitsSold: number;
  sellThroughRate: number;
  daysOfStock: number | null;
  velocity: "fast" | "normal" | "slow" | "dead";
  needsReorder: boolean;
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

function fmt(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

function channelLabel(ch: string): string {
  const map: Record<string, string> = {
    shopify_dtc: "Shopify DTC", shopify_wholesale: "Wholesale", faire: "Faire", direct: "Direct", phone: "Phone",
  };
  return map[ch] || ch;
}

const trendArrow = (dir: string) => {
  if (dir === "up") return <TrendingUp className="h-4 w-4 text-green-500" />;
  if (dir === "down") return <TrendingDown className="h-4 w-4 text-red-500" />;
  return <span className="text-muted-foreground">→</span>;
};

// ── Health Gauge ──

function HealthGauge({ health }: { health: BusinessHealth }) {
  const colorMap = { green: "text-green-500", yellow: "text-yellow-500", red: "text-red-500" };
  const bgMap = { green: "bg-green-500", yellow: "bg-yellow-500", red: "bg-red-500" };
  const ringMap = { green: "ring-green-200", yellow: "ring-yellow-200", red: "ring-red-200" };

  return (
    <Card className="col-span-full md:col-span-2">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Heart className="h-4 w-4" /> Business Health Score
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-8">
          {/* Gauge circle */}
          <div className={`relative flex items-center justify-center w-28 h-28 rounded-full ring-8 ${ringMap[health.color]}`}>
            <div className="text-center">
              <span className={`text-3xl font-bold ${colorMap[health.color]}`}>{health.overall}</span>
              <p className="text-xs text-muted-foreground capitalize">{health.status}</p>
            </div>
          </div>

          {/* Component bars */}
          <div className="flex-1 space-y-3">
            {Object.entries(health.components).map(([key, comp]) => (
              <div key={key} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="capitalize font-medium">{key}</span>
                  <span className="flex items-center gap-1">
                    {trendArrow(comp.trend)}
                    <span className="font-mono">{comp.score}</span>
                  </span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      comp.score >= 80 ? "bg-green-500" : comp.score >= 60 ? "bg-yellow-500" : "bg-red-500"
                    }`}
                    style={{ width: `${comp.score}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">{comp.label}</p>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main Page ──

export default function IntelligencePage() {
  const [trends, setTrends] = useState<TrendData | null>(null);
  const [health, setHealth] = useState<BusinessHealth | null>(null);
  const [reports, setReports] = useState<ReportData[]>([]);
  const [activeReport, setActiveReport] = useState<ReportData | null>(null);
  const [sellThrough, setSellThrough] = useState<SellThroughData | null>(null);
  const [pipelineData, setPipelineData] = useState<PipelineData | null>(null);
  const [loading, setLoading] = useState({ trends: false, health: false, report: false, sellThrough: false, pipeline: false });
  const [periodDays, setPeriodDays] = useState(30);
  const [sellThroughSort, setSellThroughSort] = useState<"velocity" | "sellThrough" | "stock">("velocity");

  const loadHealth = useCallback(async () => {
    setLoading((l) => ({ ...l, health: true }));
    try {
      const res = await fetch("/api/v1/intelligence/health");
      setHealth(await res.json());
    } catch {} finally {
      setLoading((l) => ({ ...l, health: false }));
    }
  }, []);

  const loadTrends = useCallback(async () => {
    setLoading((l) => ({ ...l, trends: true }));
    try {
      const res = await fetch(`/api/v1/intelligence/trends?period=${periodDays}`);
      setTrends(await res.json());
    } catch {} finally {
      setLoading((l) => ({ ...l, trends: false }));
    }
  }, [periodDays]);

  const loadSellThrough = useCallback(async () => {
    setLoading((l) => ({ ...l, sellThrough: true }));
    try {
      const res = await fetch(`/api/v1/inventory/sell-through?window=${periodDays}`);
      setSellThrough(await res.json());
    } catch {} finally {
      setLoading((l) => ({ ...l, sellThrough: false }));
    }
  }, [periodDays]);

  const loadPipeline = useCallback(async () => {
    setLoading((l) => ({ ...l, pipeline: true }));
    try {
      const res = await fetch("/api/v1/intelligence/pipeline");
      setPipelineData(await res.json());
    } catch {} finally {
      setLoading((l) => ({ ...l, pipeline: false }));
    }
  }, []);

  const loadReports = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/intelligence/reports?limit=10");
      const json = await res.json();
      setReports(json.reports || []);
    } catch {}
  }, []);

  const generateReport = useCallback(async (period: "weekly" | "monthly") => {
    setLoading((l) => ({ ...l, report: true }));
    try {
      const res = await fetch("/api/v1/intelligence/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period }),
      });
      const report = await res.json();
      setActiveReport(report);
      loadReports();
    } catch {} finally {
      setLoading((l) => ({ ...l, report: false }));
    }
  }, [loadReports]);

  useEffect(() => {
    loadHealth();
    loadTrends();
    loadSellThrough();
    loadReports();
    loadPipeline();
  }, [loadHealth, loadTrends, loadSellThrough, loadReports, loadPipeline]);

  useEffect(() => { loadTrends(); loadSellThrough(); }, [periodDays, loadTrends, loadSellThrough]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BarChart3 className="h-6 w-6" /> Intelligence Dashboard
          </h1>
          <p className="text-muted-foreground">Business health, trends, and reports from real data</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={periodDays}
            onChange={(e) => setPeriodDays(parseInt(e.target.value))}
            className="rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days</option>
          </select>
        </div>
      </div>

      {/* Health Gauge + Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {health && <HealthGauge health={health} />}

        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-1">
              <TrendingUp className="h-3 w-3" /> Trending Up
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-green-600">{trends?.trending_up.length || 0}</p>
            <p className="text-xs text-muted-foreground">products growing</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-1">
              <TrendingDown className="h-3 w-3" /> Trending Down
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-red-600">{trends?.trending_down.length || 0}</p>
            <p className="text-xs text-muted-foreground">products declining</p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="trends">
        <TabsList>
          <TabsTrigger value="pipeline">
            <Kanban className="h-4 w-4 mr-1" /> Pipeline
          </TabsTrigger>
          <TabsTrigger value="trends">
            <Activity className="h-4 w-4 mr-1" /> Product Trends
          </TabsTrigger>
          <TabsTrigger value="channels">
            <Zap className="h-4 w-4 mr-1" /> Channels
          </TabsTrigger>
          <TabsTrigger value="sell-through">
            <ShoppingCart className="h-4 w-4 mr-1" /> Sell-Through
          </TabsTrigger>
          <TabsTrigger value="reports">
            <FileText className="h-4 w-4 mr-1" /> Reports
          </TabsTrigger>
        </TabsList>

        {/* ── Pipeline Analytics ── */}
        <TabsContent value="pipeline">
          {pipelineData ? (
            <div className="space-y-4">
              {/* Summary cards */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <Card><CardContent className="pt-4 text-center"><p className="text-2xl font-bold">{pipelineData.summary.totalDeals}</p><p className="text-xs text-muted-foreground">Total Deals</p></CardContent></Card>
                <Card><CardContent className="pt-4 text-center"><p className="text-2xl font-bold text-blue-600">{pipelineData.summary.dealsCreatedLast30}</p><p className="text-xs text-muted-foreground">Created (30d)</p></CardContent></Card>
                <Card><CardContent className="pt-4 text-center"><p className="text-2xl font-bold text-green-600">{pipelineData.summary.dealsWonLast30}</p><p className="text-xs text-muted-foreground">Won (30d)</p></CardContent></Card>
                <Card><CardContent className="pt-4 text-center"><p className="text-2xl font-bold text-red-600">{pipelineData.summary.dealsLostLast30}</p><p className="text-xs text-muted-foreground">Lost (30d)</p></CardContent></Card>
                <Card><CardContent className="pt-4 text-center"><p className="text-2xl font-bold"><Target className="h-5 w-5 inline mr-1" />{pipelineData.summary.winRate}%</p><p className="text-xs text-muted-foreground">Win Rate</p></CardContent></Card>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Deals by stage — horizontal bar chart */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Kanban className="h-4 w-4" /> Deals by Stage
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {pipelineData.byStage.map((s) => {
                        const maxCount = Math.max(...pipelineData.byStage.map((x) => x.count), 1);
                        const pct = (s.count / maxCount) * 100;
                        const stageLabels: Record<string, string> = {
                          outreach: "Outreach", contact_made: "Contact Made", interested: "Interested",
                          order_placed: "Order Placed", interested_later: "Later", not_interested: "Not Interested",
                        };
                        const stageColors: Record<string, string> = {
                          outreach: "bg-blue-500", contact_made: "bg-yellow-500", interested: "bg-green-500",
                          order_placed: "bg-emerald-500", interested_later: "bg-orange-500", not_interested: "bg-red-500",
                        };
                        return (
                          <div key={s.stage} className="space-y-1">
                            <div className="flex items-center justify-between text-sm">
                              <span className="font-medium">{stageLabels[s.stage] || s.stage}</span>
                              <span className="text-muted-foreground">{s.count} deals · {fmt(s.total_value)} · {s.avg_days}d avg</span>
                            </div>
                            <div className="h-3 bg-muted rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${stageColors[s.stage] || "bg-gray-500"}`} style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>

                {/* Conversion funnel */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <TrendingUp className="h-4 w-4" /> Conversion Funnel
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {pipelineData.funnel.map((f, i) => {
                        const maxCount = Math.max(...pipelineData.funnel.map((x) => x.count), 1);
                        const pct = (f.count / maxCount) * 100;
                        const stageLabels: Record<string, string> = {
                          outreach: "Outreach", contact_made: "Contact Made", interested: "Interested", order_placed: "Order Placed",
                        };
                        return (
                          <div key={f.stage}>
                            <div className="flex items-center justify-between text-sm mb-1">
                              <span className="font-medium">{stageLabels[f.stage] || f.stage}</span>
                              <span>
                                <span className="font-bold">{f.count}</span>
                                {i > 0 && (
                                  <span className={`ml-2 text-xs ${f.rate >= 50 ? "text-green-600" : f.rate >= 25 ? "text-yellow-600" : "text-red-600"}`}>
                                    {f.rate}% from prev
                                  </span>
                                )}
                              </span>
                            </div>
                            <div className="h-8 bg-muted rounded overflow-hidden flex items-center">
                              <div
                                className="h-full bg-primary/70 rounded flex items-center justify-center text-xs text-primary-foreground font-medium transition-all"
                                style={{ width: `${Math.max(pct, 5)}%` }}
                              >
                                {pct > 15 ? f.count : ""}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Stage transitions */}
              {pipelineData.stageTransitions.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Stage Transitions (avg days between)</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>From</TableHead>
                          <TableHead>To</TableHead>
                          <TableHead className="text-right">Count</TableHead>
                          <TableHead className="text-right">Avg Days</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pipelineData.stageTransitions.map((t) => {
                          const labels: Record<string, string> = {
                            outreach: "Outreach", contact_made: "Contact Made", interested: "Interested",
                            order_placed: "Order Placed", interested_later: "Later", not_interested: "Not Interested",
                          };
                          return (
                            <TableRow key={`${t.from_stage}-${t.to_stage}`}>
                              <TableCell>{labels[t.from_stage] || t.from_stage}</TableCell>
                              <TableCell>{labels[t.to_stage] || t.to_stage}</TableCell>
                              <TableCell className="text-right">{t.transition_count}</TableCell>
                              <TableCell className="text-right font-medium">{t.avg_days_between}d</TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}
            </div>
          ) : (
            <p className="text-center text-muted-foreground py-8">
              {loading.pipeline ? "Loading pipeline analytics..." : "No pipeline data available"}
            </p>
          )}
        </TabsContent>

        {/* ── Product Trends ── */}
        <TabsContent value="trends">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Product Trends — {periodDays}-day comparison</h2>
            <button
              onClick={loadTrends}
              disabled={loading.trends}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted"
            >
              <RefreshCw className={`h-4 w-4 ${loading.trends ? "animate-spin" : ""}`} /> Detect Trends
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Trending Up */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-green-500" /> Growing Products
                </CardTitle>
              </CardHeader>
              <CardContent>
                {(!trends?.trending_up.length) ? (
                  <p className="text-center text-muted-foreground py-6">No upward trends detected</p>
                ) : (
                  <div className="space-y-3">
                    {trends.trending_up.slice(0, 10).map((t) => (
                      <div key={t.sku} className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{t.productName}</div>
                          <div className="text-xs text-muted-foreground">{t.sku}{t.colorName ? ` · ${t.colorName}` : ""}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-green-600 font-bold flex items-center gap-1 justify-end">
                            <TrendingUp className="h-3 w-3" /> +{t.growthRate}%
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {t.priorPeriodUnits} → {t.currentPeriodUnits} units
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Trending Down */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingDown className="h-4 w-4 text-red-500" /> Declining Products
                </CardTitle>
              </CardHeader>
              <CardContent>
                {(!trends?.trending_down.length) ? (
                  <p className="text-center text-muted-foreground py-6">No declining trends detected</p>
                ) : (
                  <div className="space-y-3">
                    {trends.trending_down.slice(0, 10).map((t) => (
                      <div key={t.sku} className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{t.productName}</div>
                          <div className="text-xs text-muted-foreground">{t.sku}{t.colorName ? ` · ${t.colorName}` : ""}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-red-600 font-bold flex items-center gap-1 justify-end">
                            <TrendingDown className="h-3 w-3" /> {t.growthRate}%
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {t.priorPeriodUnits} → {t.currentPeriodUnits} units
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Dead Stock */}
          {trends?.dead_stock && trends.dead_stock.length > 0 && (
            <Card className="mt-4">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Package className="h-4 w-4 text-red-500" /> Dead Stock ({trends.dead_stock.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Days Since Last Sale</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trends.dead_stock.map((d) => (
                      <TableRow key={d.sku}>
                        <TableCell className="font-mono text-sm">{d.sku}</TableCell>
                        <TableCell>{d.name}</TableCell>
                        <TableCell className="text-right text-red-600 font-medium">{d.days_since_sale}d</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Channel Performance ── */}
        <TabsContent value="channels">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Channel Performance — {periodDays}-day comparison</CardTitle>
            </CardHeader>
            <CardContent>
              {(!trends?.channel_trends.length) ? (
                <p className="text-center text-muted-foreground py-8">No channel data available</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Channel</TableHead>
                      <TableHead className="text-right">Current Orders</TableHead>
                      <TableHead className="text-right">Prior Orders</TableHead>
                      <TableHead className="text-right">Current Revenue</TableHead>
                      <TableHead className="text-right">Prior Revenue</TableHead>
                      <TableHead className="text-right">Growth</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trends.channel_trends.map((ch) => (
                      <TableRow key={ch.channel}>
                        <TableCell className="font-medium">{channelLabel(ch.channel)}</TableCell>
                        <TableCell className="text-right">{ch.currentPeriodOrders}</TableCell>
                        <TableCell className="text-right text-muted-foreground">{ch.priorPeriodOrders}</TableCell>
                        <TableCell className="text-right">{fmt(ch.currentPeriodRevenue)}</TableCell>
                        <TableCell className="text-right text-muted-foreground">{fmt(ch.priorPeriodRevenue)}</TableCell>
                        <TableCell className="text-right">
                          <span className={`font-bold flex items-center gap-1 justify-end ${
                            ch.growthRate > 0 ? "text-green-600" : ch.growthRate < 0 ? "text-red-600" : ""
                          }`}>
                            {ch.growthRate > 0 ? <TrendingUp className="h-3 w-3" /> : ch.growthRate < 0 ? <TrendingDown className="h-3 w-3" /> : null}
                            {ch.growthRate > 0 ? "+" : ""}{ch.growthRate}%
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Sell-Through ── */}
        <TabsContent value="sell-through">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Sell-Through Analysis — {periodDays}-day window</h2>
            <button
              onClick={loadSellThrough}
              disabled={loading.sellThrough}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted"
            >
              <RefreshCw className={`h-4 w-4 ${loading.sellThrough ? "animate-spin" : ""}`} /> Refresh
            </button>
          </div>

          {sellThrough && (
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
              <Card><CardContent className="pt-4 text-center"><p className="text-2xl font-bold text-green-600">{sellThrough.summary.fastMovers}</p><p className="text-xs text-muted-foreground">Fast Movers</p></CardContent></Card>
              <Card><CardContent className="pt-4 text-center"><p className="text-2xl font-bold">{sellThrough.summary.normalMovers}</p><p className="text-xs text-muted-foreground">Normal</p></CardContent></Card>
              <Card><CardContent className="pt-4 text-center"><p className="text-2xl font-bold text-yellow-600">{sellThrough.summary.slowMovers}</p><p className="text-xs text-muted-foreground">Slow Movers</p></CardContent></Card>
              <Card><CardContent className="pt-4 text-center"><p className="text-2xl font-bold text-red-600">{sellThrough.summary.deadStock}</p><p className="text-xs text-muted-foreground">Dead Stock</p></CardContent></Card>
              <Card><CardContent className="pt-4 text-center"><p className="text-2xl font-bold text-orange-600">{sellThrough.summary.needsReorder}</p><p className="text-xs text-muted-foreground">Needs Reorder</p></CardContent></Card>
              <Card><CardContent className="pt-4 text-center"><p className="text-2xl font-bold text-red-500">{sellThrough.summary.outOfStock}</p><p className="text-xs text-muted-foreground">Out of Stock</p></CardContent></Card>
            </div>
          )}

          <Card>
            <CardContent className="pt-4">
              {!sellThrough?.items.length ? (
                <p className="text-center text-muted-foreground py-8">No sell-through data available</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right cursor-pointer" onClick={() => setSellThroughSort("stock")}>
                        Stock <ArrowUpDown className="h-3 w-3 inline" />
                      </TableHead>
                      <TableHead className="text-right cursor-pointer" onClick={() => setSellThroughSort("sellThrough")}>
                        Sell-Through % <ArrowUpDown className="h-3 w-3 inline" />
                      </TableHead>
                      <TableHead className="text-right">Units Sold</TableHead>
                      <TableHead className="text-right">Days of Stock</TableHead>
                      <TableHead className="cursor-pointer" onClick={() => setSellThroughSort("velocity")}>
                        Velocity <ArrowUpDown className="h-3 w-3 inline" />
                      </TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...sellThrough.items]
                      .sort((a, b) => {
                        if (sellThroughSort === "sellThrough") return b.sellThroughRate - a.sellThroughRate;
                        if (sellThroughSort === "stock") return a.currentStock - b.currentStock;
                        const order = { fast: 0, normal: 1, slow: 2, dead: 3 };
                        return order[a.velocity] - order[b.velocity];
                      })
                      .map((item) => (
                        <TableRow key={item.sku}>
                          <TableCell className="font-mono text-sm">{item.sku}</TableCell>
                          <TableCell>
                            <div className="font-medium">{item.productName}</div>
                            {item.colorName && <div className="text-xs text-muted-foreground">{item.colorName}</div>}
                          </TableCell>
                          <TableCell className="text-right">{item.currentStock}</TableCell>
                          <TableCell className="text-right font-medium">{item.sellThroughRate.toFixed(1)}%</TableCell>
                          <TableCell className="text-right">{item.unitsSold}</TableCell>
                          <TableCell className="text-right">{item.daysOfStock != null ? `${item.daysOfStock}d` : "—"}</TableCell>
                          <TableCell>
                            <Badge variant={item.velocity === "fast" ? "default" : item.velocity === "normal" ? "secondary" : item.velocity === "slow" ? "outline" : "destructive"} className="text-xs">
                              {item.velocity}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {item.needsReorder && <Badge variant="destructive" className="text-xs">Reorder</Badge>}
                            {item.currentStock === 0 && <Badge variant="destructive" className="text-xs">OOS</Badge>}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Reports ── */}
        <TabsContent value="reports">
          <div className="flex items-center gap-2 mb-4">
            <button
              onClick={() => generateReport("weekly")}
              disabled={loading.report}
              className="inline-flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm hover:bg-primary/90"
            >
              <FileText className="h-4 w-4" />
              {loading.report ? "Generating..." : "Generate Weekly Report"}
            </button>
            <button
              onClick={() => generateReport("monthly")}
              disabled={loading.report}
              className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm hover:bg-muted"
            >
              Generate Monthly Report
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Report list */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Report History</CardTitle>
              </CardHeader>
              <CardContent>
                {reports.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4">No reports generated yet. Click above to create one.</p>
                ) : (
                  <div className="space-y-2">
                    {reports.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => setActiveReport(r)}
                        className={`w-full text-left px-3 py-2 rounded-md text-sm hover:bg-muted transition ${
                          activeReport?.id === r.id ? "bg-muted ring-1 ring-primary" : ""
                        }`}
                      >
                        <div className="font-medium capitalize">{r.period} Report</div>
                        <div className="text-xs text-muted-foreground">
                          {r.dateRange.from} — {r.dateRange.to}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant="outline" className="text-xs">{fmt(r.revenue.total)}</Badge>
                          <Badge variant="outline" className="text-xs">{r.orders.count} orders</Badge>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Report viewer */}
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {activeReport ? `${activeReport.period} Report — ${activeReport.dateRange.from} to ${activeReport.dateRange.to}` : "Report Viewer"}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!activeReport ? (
                  <p className="text-muted-foreground py-8 text-center">Select or generate a report to view it here</p>
                ) : (
                  <div className="space-y-4">
                    {/* Quick stats */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="bg-muted rounded-lg p-3">
                        <p className="text-xs text-muted-foreground">Revenue</p>
                        <p className="text-lg font-bold">{fmt(activeReport.revenue.total)}</p>
                        <p className={`text-xs font-medium ${activeReport.revenue.changePercent > 0 ? "text-green-600" : "text-red-600"}`}>
                          {activeReport.revenue.changePercent > 0 ? "+" : ""}{activeReport.revenue.changePercent}%
                        </p>
                      </div>
                      <div className="bg-muted rounded-lg p-3">
                        <p className="text-xs text-muted-foreground">Orders</p>
                        <p className="text-lg font-bold">{activeReport.orders.count}</p>
                        <p className="text-xs text-muted-foreground">prior: {activeReport.orders.priorCount}</p>
                      </div>
                      <div className="bg-muted rounded-lg p-3">
                        <p className="text-xs text-muted-foreground">AOV</p>
                        <p className="text-lg font-bold">{fmt(activeReport.orders.avgOrderValue)}</p>
                      </div>
                      <div className="bg-muted rounded-lg p-3">
                        <p className="text-xs text-muted-foreground">Health</p>
                        <p className={`text-lg font-bold ${
                          activeReport.healthScore >= 80 ? "text-green-600" : activeReport.healthScore >= 60 ? "text-yellow-600" : "text-red-600"
                        }`}>{activeReport.healthScore}/100</p>
                        <p className="text-xs text-muted-foreground capitalize">{activeReport.healthStatus}</p>
                      </div>
                    </div>

                    {/* Top products */}
                    {activeReport.topProducts.length > 0 && (
                      <div>
                        <h3 className="text-sm font-semibold mb-2">Top Products</h3>
                        <div className="space-y-2">
                          {activeReport.topProducts.slice(0, 5).map((p, i) => (
                            <div key={p.sku} className="flex items-center gap-2 text-sm">
                              <span className="text-muted-foreground w-5">#{i + 1}</span>
                              <span className="flex-1 truncate">{p.name}</span>
                              <span className="text-muted-foreground">{p.units} units</span>
                              <span className="font-medium">{fmt(p.revenue)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Channel breakdown */}
                    {activeReport.channelBreakdown.length > 0 && (
                      <div>
                        <h3 className="text-sm font-semibold mb-2">Channel Breakdown</h3>
                        <div className="space-y-2">
                          {activeReport.channelBreakdown.map((c) => (
                            <div key={c.channel} className="flex items-center gap-2 text-sm">
                              <span className="flex-1">{channelLabel(c.channel)}</span>
                              <span className="text-muted-foreground">{c.orders} orders</span>
                              <span className="font-medium">{fmt(c.revenue)}</span>
                              <Badge variant="outline" className="text-xs">{c.percent}%</Badge>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
