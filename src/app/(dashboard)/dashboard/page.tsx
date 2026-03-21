"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  Users, Target, DollarSign, TrendingUp,
  Upload, Eye, Brain, Clock, ArrowRight, Zap, RefreshCw,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface FocusData {
  wakingToday: { id: string; title: string; company_name: string; snooze_reason: string; value: number }[];
  reorderDue: { id: string; title: string; company_name: string; reorder_due_at: string; value: number }[];
  stale: { id: string; title: string; company_name: string; last_activity_at: string; stage: string; value: number }[];
}

interface DashboardStats {
  totalProspects: number;
  outreachReady: number;
  pipelineValue: number;
  icpABCount: number;
  unscoredCount: number;
  recentActivity: Array<{
    id: string;
    event_type: string;
    module: string;
    entity_type: string;
    entity_id: string;
    data: string;
    created_at: string;
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
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Dashboard</h1>
        <p className="text-sm text-gray-500 mt-1">Sales pipeline overview</p>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          title="Total Prospects"
          value={stats?.totalProspects ?? 0}
          icon={<Users className="w-5 h-5" />}
          color="blue"
          href="/prospects"
        />
        <StatCard
          title="Outreach Ready"
          value={stats?.outreachReady ?? 0}
          icon={<Target className="w-5 h-5" />}
          color="green"
          subtitle="Has email + qualified"
        />
        <StatCard
          title="Pipeline Value"
          value={stats?.pipelineValue ?? 0}
          icon={<DollarSign className="w-5 h-5" />}
          color="purple"
          format="currency"
          subtitle="Coming in Phase 2"
        />
        <StatCard
          title="ICP A+B Prospects"
          value={stats?.icpABCount ?? 0}
          icon={<TrendingUp className="w-5 h-5" />}
          color="amber"
          subtitle="High-value targets"
        />
      </div>

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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
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

            <div className="flex items-center justify-between p-3 rounded-lg border border-dashed border-gray-200 dark:border-gray-700 opacity-60">
              <div className="flex items-center gap-3">
                <Upload className="w-5 h-5 text-gray-400" />
                <span className="text-sm text-gray-500">Import Leads</span>
              </div>
              <Badge variant="secondary" className="text-[10px]">Phase 2</Badge>
            </div>
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

            <div className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-dashed border-gray-200 dark:border-gray-700">
              <p className="text-sm text-gray-500">Re-engagement Queue</p>
              <p className="text-xs text-gray-400 mt-1">Coming in Phase 2</p>
            </div>
          </CardContent>
        </Card>

        {/* Recent Activity */}
        <Card className="lg:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {!stats?.recentActivity?.length ? (
              <p className="text-sm text-gray-400">No recent activity</p>
            ) : (
              <div className="space-y-3 max-h-64 overflow-y-auto">
                {stats.recentActivity.slice(0, 10).map(a => {
                  let description = a.event_type.replace(/_/g, " ");
                  try {
                    const data = JSON.parse(a.data);
                    if (data.fields) description += `: ${data.fields.join(", ")}`;
                    if (data.name) description += `: ${data.name}`;
                    if (data.count !== undefined) description += ` (${data.count})`;
                  } catch {}
                  return (
                    <div key={a.id} className="flex gap-3 text-sm">
                      <div className="w-2 h-2 rounded-full bg-blue-400 mt-1.5 shrink-0" />
                      <div>
                        <p className="text-gray-700 dark:text-gray-300 capitalize">{description}</p>
                        <p className="text-xs text-gray-400 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {a.created_at ? new Date(a.created_at + "Z").toLocaleString() : "—"}
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
    </div>
  );
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
