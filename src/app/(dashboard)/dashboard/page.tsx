"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  Users, Target, DollarSign, TrendingUp,
  Upload, Eye, Brain, Clock, ArrowRight, Zap, RefreshCw,
  ShoppingCart, Package, Bell, Kanban, Truck, AlertTriangle,
  Heart, CreditCard, BarChart3, Bot, Boxes,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";


interface FocusData {
  wakingToday: { id: string; title: string; company_name: string; snooze_reason: string; value: number }[];
  reorderDue: { id: string; title: string; company_name: string; reorder_due_at: string; value: number }[];
  stale: { id: string; title: string; company_name: string; last_activity_at: string; stage: string; value: number }[];
}

interface DashboardStats {
  totalProspects: number;
  outreachReady: number;
  pipelineValue: number;
  activeDeals: number;
  icpABCount: number;
  unscoredCount: number;
  pendingOrders: number;
  totalRevenue: number;
  inventoryUnits: number;
  inventorySkus: number;
  inventoryValue: number;
  revenueByChannel: Array<{ channel: string; revenue: number; orderCount: number }>;
  unreadNotifications: number;
  recentActivity: Array<{
    id: string;
    event_type: string;
    module: string;
    entity_type: string;
    entity_id: string;
    data: string;
    created_at: string;
    entity_name: string | null;
    entity_href: string | null;
  }>;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [classifying, setClassifying] = useState(false);
  const [classifyResult, setClassifyResult] = useState<string | null>(null);
  const [focus, setFocus] = useState<FocusData | null>(null);

  useEffect(() => {
    fetchStats();
    fetchFocus();
  }, []);

  const fetchFocus = async () => {
    try {
      const res = await fetch("/api/v1/sales/focus");
      setFocus(await res.json());
    } catch {}
  };

  const fetchStats = async () => {
    try {
      const res = await fetch("/api/v1/sales/dashboard");
      const data = await res.json();
      setStats(data);
    } catch (err) {
      console.error("Failed to load dashboard:", err);
    } finally {
      setLoading(false);
    }
  };

  const runIcpClassifier = async () => {
    setClassifying(true);
    setClassifyResult(null);
    try {
      const res = await fetch("/api/v1/sales/agents/icp-classify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.processed !== undefined) {
        setClassifyResult(`Classified ${data.processed} companies`);
      } else if (data.runId) {
        setClassifyResult(`Classification running (${data.status})`);
      } else {
        setClassifyResult(data.message || "Done");
      }
      fetchStats(); // Refresh stats
    } catch {
      setClassifyResult("Classification failed");
    } finally {
      setClassifying(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6 max-w-[1200px] mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {[1, 2, 3, 4].map(i => (
            <Card key={i} className="animate-pulse">
              <CardContent className="pt-6"><div className="h-16 bg-gray-100 dark:bg-gray-800 rounded" /></CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-[1200px] mx-auto">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">Business overview</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { setLoading(true); fetchStats(); fetchFocus(); }}
          disabled={loading}
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Stats cards - row 1 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <StatCard
          title="Total Prospects"
          value={stats?.totalProspects ?? 0}
          icon={<Users className="w-5 h-5" />}
          color="blue"
          href="/prospects"
        />
        <StatCard
          title="Active Deals"
          value={stats?.activeDeals ?? 0}
          icon={<Target className="w-5 h-5" />}
          color="green"
          subtitle={`Pipeline: $${(stats?.pipelineValue ?? 0).toLocaleString()}`}
          href="/pipeline"
        />
        <StatCard
          title="Pending Orders"
          value={stats?.pendingOrders ?? 0}
          icon={<ShoppingCart className="w-5 h-5" />}
          color="purple"
          subtitle={`Revenue: $${(stats?.totalRevenue ?? 0).toLocaleString()}`}
          href="/orders"
        />
        <StatCard
          title="Inventory"
          value={stats?.inventoryValue ?? 0}
          icon={<Package className="w-5 h-5" />}
          color="amber"
          format="currency"
          subtitle={`${(stats?.inventoryUnits ?? 0).toLocaleString()} units · ${stats?.inventorySkus ?? 0} SKUs`}
          href="/inventory"
        />
      </div>

      {/* Stats cards - row 2 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          title="Outreach Ready"
          value={stats?.outreachReady ?? 0}
          icon={<Target className="w-5 h-5" />}
          color="green"
          subtitle="Has email + qualified"
        />
        <StatCard
          title="ICP A+B Prospects"
          value={stats?.icpABCount ?? 0}
          icon={<TrendingUp className="w-5 h-5" />}
          color="amber"
          subtitle="High-value targets"
        />
        <StatCard
          title="Pipeline Value"
          value={stats?.pipelineValue ?? 0}
          icon={<DollarSign className="w-5 h-5" />}
          color="purple"
          format="currency"
        />
        {(stats?.unreadNotifications ?? 0) > 0 && (
          <StatCard
            title="Unread Notifications"
            value={stats?.unreadNotifications ?? 0}
            icon={<Bell className="w-5 h-5" />}
            color="blue"
            href="/notifications"
          />
        )}
      </div>

      {/* Revenue by Channel */}
      {stats?.revenueByChannel && stats.revenueByChannel.length > 0 && (
        <Card className="mb-6">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-green-500" /> Revenue by Channel
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {stats.revenueByChannel.map((ch) => {
                const channelLabels: Record<string, string> = {
                  shopify_dtc: "Shopify DTC",
                  shopify_wholesale: "Shopify Wholesale",
                  faire: "Faire",
                  direct: "Direct",
                  phone: "Phone",
                };
                return (
                  <div key={ch.channel} className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                    <p className="text-xs text-gray-500 font-medium">{channelLabels[ch.channel] ?? ch.channel}</p>
                    <p className="text-lg font-bold text-gray-900 dark:text-white mt-1">
                      ${ch.revenue.toLocaleString()}
                    </p>
                    <p className="text-xs text-gray-400">{ch.orderCount} orders</p>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Today's Focus */}
      {focus && (focus.wakingToday.length > 0 || focus.reorderDue.length > 0 || focus.stale.length > 0) && (
        <Card className="mb-6">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              🎯 Today&apos;s Focus
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {focus.wakingToday.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-amber-700 mb-2">⏰ Waking Today ({focus.wakingToday.length})</h4>
                  {focus.wakingToday.map(d => (
                    <Link key={d.id} href={`/pipeline/${d.id}`} className="block p-2 rounded hover:bg-amber-50 dark:hover:bg-amber-900/10 text-sm">
                      <span className="font-medium">{d.company_name}</span>
                      {d.snooze_reason && <span className="text-xs text-gray-500 block">{d.snooze_reason}</span>}
                    </Link>
                  ))}
                </div>
              )}
              {focus.reorderDue.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-teal-700 mb-2">🔄 Reorder Due ({focus.reorderDue.length})</h4>
                  {focus.reorderDue.map(d => (
                    <Link key={d.id} href={`/pipeline/${d.id}`} className="block p-2 rounded hover:bg-teal-50 dark:hover:bg-teal-900/10 text-sm">
                      <span className="font-medium">{d.company_name}</span>
                      {d.value && <span className="text-xs text-green-600 ml-2">${d.value.toLocaleString()}</span>}
                    </Link>
                  ))}
                </div>
              )}
              {focus.stale.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-red-700 mb-2">💤 Needs Attention ({focus.stale.length})</h4>
                  {focus.stale.map(d => (
                    <Link key={d.id} href={`/pipeline/${d.id}`} className="block p-2 rounded hover:bg-red-50 dark:hover:bg-red-900/10 text-sm">
                      <span className="font-medium">{d.company_name}</span>
                      <span className="text-xs text-gray-500 block">No activity for 7+ days</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Quick Actions */}
        <Card className="lg:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Quick Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Link href="/prospects" className="flex items-center justify-between p-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 border border-gray-100 dark:border-gray-700 group">
              <div className="flex items-center gap-3">
                <Eye className="w-5 h-5 text-blue-500" />
                <span className="text-sm font-medium">View Prospects</span>
              </div>
              <ArrowRight className="w-4 h-4 text-gray-400 group-hover:text-gray-600" />
            </Link>

            <button onClick={runIcpClassifier} disabled={classifying}
              className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 border border-gray-100 dark:border-gray-700 group disabled:opacity-50">
              <div className="flex items-center gap-3">
                {classifying ? <RefreshCw className="w-5 h-5 text-purple-500 animate-spin" /> : <Brain className="w-5 h-5 text-purple-500" />}
                <div className="text-left">
                  <span className="text-sm font-medium block">Run ICP Classifier</span>
                  {stats?.unscoredCount ? (
                    <span className="text-xs text-gray-500">{stats.unscoredCount.toLocaleString()} unscored</span>
                  ) : (
                    <span className="text-xs text-green-500">All scored ✓</span>
                  )}
                </div>
              </div>
              <Zap className="w-4 h-4 text-gray-400 group-hover:text-gray-600" />
            </button>

            {classifyResult && (
              <div className="p-2 bg-green-50 dark:bg-green-900/20 rounded-lg text-sm text-green-700 dark:text-green-400">
                {classifyResult}
              </div>
            )}

            <Link href="/prospects?import=1" className="flex items-center justify-between p-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 border border-gray-100 dark:border-gray-700 group">
              <div className="flex items-center gap-3">
                <Upload className="w-5 h-5 text-green-500" />
                <span className="text-sm font-medium">Import Leads</span>
              </div>
              <ArrowRight className="w-4 h-4 text-gray-400 group-hover:text-gray-600" />
            </Link>
          </CardContent>
        </Card>

        {/* AI Insights */}
        <Card className="lg:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Brain className="w-4 h-4 text-purple-500" /> AI Insights
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {stats?.unscoredCount && stats.unscoredCount > 0 ? (
              <div className="p-3 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
                <p className="text-sm font-medium text-purple-800 dark:text-purple-300">
                  ICP Classification Available
                </p>
                <p className="text-xs text-purple-600 dark:text-purple-400 mt-1">
                  {stats.unscoredCount.toLocaleString()} prospects need ICP scoring.
                  Run the classifier to prioritize your pipeline.
                </p>
              </div>
            ) : (
              <div className="p-3 bg-green-50 dark:bg-green-900/20 rounded-lg">
                <p className="text-sm font-medium text-green-800 dark:text-green-300">
                  All Prospects Scored ✓
                </p>
                <p className="text-xs text-green-600 dark:text-green-400 mt-1">
                  ICP classification is complete for all prospects.
                </p>
              </div>
            )}

            <Link href="/pipeline?filter=stale" className="block p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors">
              <p className="text-sm font-medium text-blue-800 dark:text-blue-300">
                Re-engagement Queue
              </p>
              <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">
                View stale deals that need follow-up
              </p>
            </Link>
          </CardContent>
        </Card>
      </div>

      {/* Activity Feed — full width */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="w-4 h-4 text-gray-500" /> Recent Activity
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!stats?.recentActivity?.length ? (
            <p className="text-sm text-gray-400">No recent activity yet. Events will appear here as you use the system.</p>
          ) : (
            <div className="space-y-1 max-h-[480px] overflow-y-auto">
              {stats.recentActivity.map(a => {
                const { icon, color, label } = getActivityMeta(a.event_type, a.module);
                let detail = "";
                try {
                  const data = typeof a.data === "string" ? JSON.parse(a.data) : a.data;
                  if (data.toStage) detail = `→ ${data.toStage.replace(/_/g, " ")}`;
                  else if (data.value) detail = `$${Number(data.value).toLocaleString()}`;
                  else if (data.count !== undefined) detail = `(${data.count} items)`;
                  else if (data.total) detail = `$${Number(data.total).toLocaleString()}`;
                  else if (data.stores) detail = `→ ${(data.stores as string[]).join(", ")}`;
                  else if (data.status) detail = `→ ${data.status}`;
                } catch {}
                const entityLabel = a.entity_name || a.entity_id?.slice(0, 8) || "";
                return (
                  <div key={a.id} className="flex items-start gap-3 py-2 px-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                    <div className={`mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${color}`}>
                      {icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-800 dark:text-gray-200">
                        <span className="font-medium">{label}</span>
                        {entityLabel && (
                          a.entity_href ? (
                            <Link href={a.entity_href} className="ml-1 text-blue-600 dark:text-blue-400 hover:underline">{entityLabel}</Link>
                          ) : (
                            <span className="ml-1 text-gray-600 dark:text-gray-400">{entityLabel}</span>
                          )
                        )}
                        {detail && <span className="ml-1 text-gray-500">{detail}</span>}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {a.created_at ? formatRelativeTime(a.created_at) : "—"}
                        <span className="mx-1.5">·</span>
                        <span className="capitalize">{a.module}</span>
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const MODULE_ICONS: Record<string, { icon: React.ReactNode; color: string }> = {
  sales: { icon: <Users className="w-4 h-4" />, color: "bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400" },
  orders: { icon: <ShoppingCart className="w-4 h-4" />, color: "bg-purple-50 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400" },
  inventory: { icon: <Boxes className="w-4 h-4" />, color: "bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400" },
  catalog: { icon: <Package className="w-4 h-4" />, color: "bg-teal-50 text-teal-600 dark:bg-teal-900/30 dark:text-teal-400" },
  finance: { icon: <CreditCard className="w-4 h-4" />, color: "bg-green-50 text-green-600 dark:bg-green-900/30 dark:text-green-400" },
  customers: { icon: <Heart className="w-4 h-4" />, color: "bg-pink-50 text-pink-600 dark:bg-pink-900/30 dark:text-pink-400" },
  intelligence: { icon: <Bot className="w-4 h-4" />, color: "bg-violet-50 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400" },
};

const EVENT_LABELS: Record<string, { icon?: React.ReactNode; label: string }> = {
  "deal.won": { icon: <Target className="w-4 h-4" />, label: "Deal won" },
  "deal.stage_changed": { icon: <Kanban className="w-4 h-4" />, label: "Deal stage changed" },
  "order.created": { icon: <ShoppingCart className="w-4 h-4" />, label: "New order" },
  "order.confirmed": { label: "Order confirmed" },
  "order.shipped": { icon: <Truck className="w-4 h-4" />, label: "Order shipped" },
  "order.delivered": { label: "Order delivered" },
  "inventory.below_reorder": { icon: <AlertTriangle className="w-4 h-4" />, label: "Low stock alert" },
  "customer.health_changed": { label: "Customer health changed" },
  "po.status_changed": { label: "PO status changed" },
  "agent.completed": { icon: <Bot className="w-4 h-4" />, label: "Agent completed" },
  "agent.error": { label: "Agent error" },
  "payment.received": { icon: <DollarSign className="w-4 h-4" />, label: "Payment received" },
  "product.trend_change": { icon: <BarChart3 className="w-4 h-4" />, label: "Product trend" },
  "product.created": { icon: <Package className="w-4 h-4" />, label: "Product created" },
  "product.status_changed": { label: "Product status changed" },
  "product.shopify_pushed": { icon: <Upload className="w-4 h-4" />, label: "Pushed to Shopify" },
};

function getActivityMeta(eventType: string, module: string) {
  const eventMeta = EVENT_LABELS[eventType];
  const moduleMeta = MODULE_ICONS[module] || MODULE_ICONS.sales;
  return {
    icon: eventMeta?.icon || moduleMeta.icon,
    color: moduleMeta.color,
    label: eventMeta?.label || eventType.replace(/[._]/g, " "),
  };
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function StatCard({ title, value, icon, color, subtitle, href, format }: {
  title: string; value: number; icon: React.ReactNode; color: string;
  subtitle?: string; href?: string; format?: "currency";
}) {
  const colorMap: Record<string, string> = {
    blue: "bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400",
    green: "bg-green-50 text-green-600 dark:bg-green-900/30 dark:text-green-400",
    purple: "bg-purple-50 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400",
    amber: "bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400",
  };

  const content = (
      <Card className={href ? "hover:shadow-md transition-shadow cursor-pointer" : ""}>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">{title}</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">
                {format === "currency" ? `$${value.toLocaleString()}` : value.toLocaleString()}
              </p>
              {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
            </div>
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${colorMap[color]}`}>
              {icon}
            </div>
          </div>
        </CardContent>
      </Card>
  );

  return href ? <Link href={href}>{content}</Link> : content;
}
