"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Brain, Play, CheckCircle, XCircle, Clock, Loader2, RefreshCw, Zap, DollarSign, Activity } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";

// ── Types ──

interface AgentData {
  name: string;
  module: string;
  config: { mode: string; model?: string };
  enabled: boolean;
  totalRuns: number;
  successCount: number;
  failedCount: number;
  totalTokens: number;
  totalCost: number;
  lastRunAt: string | null;
  lastStatus: string | null;
}

interface RunData {
  id: string;
  agentName: string;
  module: string;
  status: string;
  input: unknown;
  output: unknown;
  tokensUsed: number | null;
  cost: number | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface JobData {
  id: string;
  type: string;
  module: string;
  status: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface DashboardData {
  agents: AgentData[];
  recentRuns: RunData[];
  jobQueue: JobData[];
  jobStats: Record<string, number>;
  tokenTotals: { totalTokens: number; totalCostCents: number };
}

// ── Helpers ──

function statusBadge(status: string) {
  const variants: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ReactNode }> = {
    completed: { variant: "default", icon: <CheckCircle className="h-3 w-3" /> },
    running: { variant: "secondary", icon: <Loader2 className="h-3 w-3 animate-spin" /> },
    pending: { variant: "outline", icon: <Clock className="h-3 w-3" /> },
    failed: { variant: "destructive", icon: <XCircle className="h-3 w-3" /> },
  };
  const v = variants[status] ?? variants.pending;
  return <Badge variant={v.variant} className="gap-1 text-xs">{v.icon} {status}</Badge>;
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ── Component ──

export default function AICommandCenter() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningAgent, setRunningAgent] = useState<string | null>(null);
  const [filterAgent, setFilterAgent] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/agents");
      if (!res.ok) throw new Error("Failed to fetch");
      setData(await res.json());
    } catch {
      toast.error("Failed to load agent data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 15s
  useEffect(() => {
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [load]);

  const toggleAgent = async (agent: AgentData) => {
    const key = `agent_enabled_${agent.name.replace(/\s+/g, "_").toLowerCase()}`;
    const next = !agent.enabled;
    try {
      await fetch("/api/v1/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: String(next) }),
      });
      toast.success(`${agent.name} ${next ? "enabled" : "disabled"}`);
      load();
    } catch {
      toast.error("Failed to toggle agent");
    }
  };

  const runAgent = async (agentName: string) => {
    setRunningAgent(agentName);
    try {
      const res = await fetch("/api/v1/agents/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: agentName }),
      });
      const result = await res.json();
      if (res.ok) {
        toast.success(`Started ${agentName} (run: ${result.runId?.slice(0, 8)}…)`);
        setTimeout(load, 1000);
      } else {
        toast.error(result.error || "Failed to run agent");
      }
    } catch {
      toast.error("Failed to trigger agent");
    } finally {
      setRunningAgent(null);
    }
  };

  if (loading || !data) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold flex items-center gap-2"><Brain className="h-6 w-6" /> AI Command Center</h1>
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  const { agents, recentRuns, jobQueue, jobStats, tokenTotals } = data;
  const successRate = agents.reduce((a, b) => a + b.successCount, 0) / Math.max(agents.reduce((a, b) => a + b.totalRuns, 0), 1) * 100;

  // Filter runs
  const filteredRuns = recentRuns.filter((r) => {
    if (filterAgent !== "all" && r.agentName !== filterAgent) return false;
    if (filterStatus !== "all" && r.status !== filterStatus) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Brain className="h-6 w-6" /> AI Command Center</h1>
          <p className="text-muted-foreground">Manage and monitor all AI agents across The Frame</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}><RefreshCw className="h-4 w-4 mr-1" /> Refresh</Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Zap className="h-4 w-4" /> Total Tokens</div>
            <p className="text-2xl font-bold">{tokenTotals.totalTokens.toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><DollarSign className="h-4 w-4" /> Total Cost</div>
            <p className="text-2xl font-bold">${(tokenTotals.totalCostCents / 100).toFixed(2)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Activity className="h-4 w-4" /> Success Rate</div>
            <p className="text-2xl font-bold text-green-600">{successRate.toFixed(1)}%</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Clock className="h-4 w-4" /> Job Queue</div>
            <p className="text-2xl font-bold">
              {(jobStats.pending ?? 0) + (jobStats.running ?? 0)}
              <span className="text-sm font-normal text-muted-foreground ml-1">active</span>
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Agent Cards */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Agents ({agents.length})</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {agents.map((agent) => (
            <Card key={agent.name} className={!agent.enabled ? "opacity-50" : ""}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium">{agent.name}</CardTitle>
                  <Switch checked={agent.enabled} onCheckedChange={() => toggleAgent(agent)} />
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">{agent.module}</Badge>
                  <Badge variant="secondary" className="text-xs">{agent.config.mode}</Badge>
                  {agent.lastStatus && statusBadge(agent.lastStatus)}
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex justify-between text-sm"><span className="text-muted-foreground">Last run</span><span>{timeAgo(agent.lastRunAt)}</span></div>
                <div className="flex justify-between text-sm"><span className="text-muted-foreground">Total runs</span><span>{agent.totalRuns}</span></div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Success</span>
                  <span className={agent.totalRuns > 0 ? (agent.successCount / agent.totalRuns >= 0.9 ? "text-green-600" : "text-orange-500") : ""}>
                    {agent.totalRuns > 0 ? `${((agent.successCount / agent.totalRuns) * 100).toFixed(0)}%` : "—"}
                  </span>
                </div>
                <div className="flex justify-between text-sm"><span className="text-muted-foreground">Tokens</span><span>{agent.totalTokens.toLocaleString()}</span></div>
                <div className="flex justify-between text-sm"><span className="text-muted-foreground">Cost</span><span>${(agent.totalCost / 100).toFixed(2)}</span></div>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full mt-2"
                  disabled={!agent.enabled || runningAgent === agent.name}
                  onClick={() => runAgent(agent.name)}
                >
                  {runningAgent === agent.name ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Play className="h-3 w-3 mr-1" />}
                  Run Now
                </Button>
              </CardContent>
            </Card>
          ))}
          {agents.length === 0 && (
            <Card className="col-span-full">
              <CardContent className="pt-6 text-center text-muted-foreground">
                No agents registered. Agents register with the orchestrator when their modules load.
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Job Queue */}
      {jobQueue.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Job Queue
              <Badge variant="secondary">{jobQueue.length} active</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead><TableHead>Module</TableHead><TableHead>Status</TableHead>
                  <TableHead>Priority</TableHead><TableHead>Attempts</TableHead><TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobQueue.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="font-medium">{job.type}</TableCell>
                    <TableCell>{job.module}</TableCell>
                    <TableCell>{statusBadge(job.status)}</TableCell>
                    <TableCell>{job.priority}</TableCell>
                    <TableCell>{job.attempts}/{job.maxAttempts}</TableCell>
                    <TableCell className="text-muted-foreground">{timeAgo(job.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Recent Runs */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Recent Agent Runs</CardTitle>
            <div className="flex gap-2">
              <Select value={filterAgent} onValueChange={(v) => setFilterAgent(v ?? "all")}>
                <SelectTrigger className="w-[160px] h-8 text-xs">
                  <SelectValue placeholder="All agents" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All agents</SelectItem>
                  {[...new Set(recentRuns.map((r) => r.agentName))].map((name) => (
                    <SelectItem key={name} value={name}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filterStatus} onValueChange={(v) => setFilterStatus(v ?? "all")}>
                <SelectTrigger className="w-[130px] h-8 text-xs">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="running">Running</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead><TableHead>Module</TableHead><TableHead>Status</TableHead>
                <TableHead>Duration</TableHead><TableHead>Tokens</TableHead><TableHead>Cost</TableHead><TableHead>Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRuns.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    {recentRuns.length === 0 ? "No agent runs yet" : "No runs match filters"}
                  </TableCell>
                </TableRow>
              ) : (
                filteredRuns.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="font-medium">{run.agentName}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{run.module}</TableCell>
                    <TableCell>{statusBadge(run.status)}</TableCell>
                    <TableCell>{run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : "—"}</TableCell>
                    <TableCell>{run.tokensUsed?.toLocaleString() ?? "—"}</TableCell>
                    <TableCell>{run.cost != null ? `$${(run.cost / 100).toFixed(2)}` : "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{timeAgo(run.createdAt)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
