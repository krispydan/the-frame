"use client";

import { useEffect, useState } from "react";
import { Loader2, Play, RefreshCw, CheckCircle, AlertCircle, Clock, SkipForward, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";

type RecentRun = {
  id: string;
  startedAt: string;
  status: string;
  durationMs: number | null;
  error: string | null;
};

type JobSummary = {
  id: string;
  schedule: string;
  description: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  inProgress: boolean;
  recentRuns: RecentRun[];
};

function StatusPill({ status }: { status: string | null }) {
  if (!status) return <Badge variant="outline"><Clock className="h-3 w-3 mr-1" />Never run</Badge>;
  if (status === "ok") return <Badge className="bg-green-600 hover:bg-green-700"><CheckCircle className="h-3 w-3 mr-1" />OK</Badge>;
  if (status === "failed") return <Badge variant="destructive"><AlertCircle className="h-3 w-3 mr-1" />Failed</Badge>;
  if (status === "skipped") return <Badge variant="outline"><SkipForward className="h-3 w-3 mr-1" />Skipped</Badge>;
  if (status === "running") return <Badge variant="outline"><Loader2 className="h-3 w-3 mr-1 animate-spin" />Running</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

function shortDuration(ms: number | null | undefined): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} hr ago`;
  return `${Math.round(ms / 86_400_000)} days ago`;
}

export default function CronJobsPage() {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  async function load() {
    const res = await fetch("/api/v1/cron/jobs");
    const data = await res.json();
    setJobs(data.jobs || []);
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);  // refresh every 30s
    return () => clearInterval(t);
  }, []);

  async function runNow(jobId: string) {
    setBusy((b) => ({ ...b, [jobId]: true }));
    try {
      const res = await fetch(`/api/v1/cron/jobs/${jobId}`, { method: "POST" });
      const data = await res.json();
      if (data.status === "ok") toast.success(`✓ ${jobId} ran in ${shortDuration(data.durationMs)}`);
      else if (data.status === "skipped") toast.info(`Skipped — ${data.error || "guard"}`);
      else toast.error(`Failed: ${data.error || "unknown"}`);
      await load();
    } finally {
      setBusy((b) => ({ ...b, [jobId]: false }));
    }
  }

  async function toggle(jobId: string, enabled: boolean) {
    setBusy((b) => ({ ...b, [jobId]: true }));
    try {
      await fetch(`/api/v1/cron/jobs/${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      await load();
    } finally {
      setBusy((b) => ({ ...b, [jobId]: false }));
    }
  }

  return (
    <div className="container mx-auto p-6 max-w-6xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Timer className="h-7 w-7" />
          Scheduled jobs
        </h1>
        <p className="text-muted-foreground mt-2">
          Centralized cron scheduler. One Railway cron service hits <code>/api/v1/cron/tick</code> every minute and runs anything due.
          Add a new job by editing <code>src/modules/integrations/lib/cron/registry.ts</code>.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between">
            <span>Jobs</span>
            <Button variant="ghost" size="sm" onClick={load}>
              <RefreshCw className="h-3 w-3 mr-1" />Refresh
            </Button>
          </CardTitle>
          <CardDescription>
            All times in UTC. Toggle off any job that should pause without a code change. &ldquo;Run now&rdquo; bypasses the schedule but still respects in-progress locks.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!jobs ? (
            <p className="text-sm text-muted-foreground"><Loader2 className="h-4 w-4 inline animate-spin mr-2" />Loading...</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[28%]">Job</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Last run</TableHead>
                  <TableHead>Last status</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead className="text-right"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((j) => (
                  <TableRow key={j.id}>
                    <TableCell>
                      <div className="font-medium">{j.id}</div>
                      <div className="text-xs text-muted-foreground">{j.description}</div>
                      {j.lastError && (
                        <div className="text-xs text-red-600 truncate max-w-[260px]" title={j.lastError}>
                          {j.lastError}
                        </div>
                      )}
                    </TableCell>
                    <TableCell><code className="text-xs">{j.schedule}</code></TableCell>
                    <TableCell className="text-xs">{relTime(j.lastRunAt)}</TableCell>
                    <TableCell>
                      {j.inProgress ? <StatusPill status="running" /> : <StatusPill status={j.lastStatus} />}
                    </TableCell>
                    <TableCell className="text-xs">{shortDuration(j.lastDurationMs)}</TableCell>
                    <TableCell>
                      <Switch
                        checked={j.enabled}
                        onCheckedChange={(v) => toggle(j.id, v)}
                        disabled={busy[j.id]}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => runNow(j.id)}
                        disabled={busy[j.id] || j.inProgress}
                      >
                        {busy[j.id] ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Play className="h-3 w-3 mr-1" />}
                        Run now
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>Last 5 runs per job, latest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {jobs && jobs.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.flatMap((j) =>
                  j.recentRuns.map((r) => ({ jobId: j.id, ...r }))
                )
                .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
                .slice(0, 30)
                .map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{r.jobId}</TableCell>
                    <TableCell className="text-xs">{new Date(r.startedAt).toLocaleString()}</TableCell>
                    <TableCell><StatusPill status={r.status} /></TableCell>
                    <TableCell className="text-xs">{shortDuration(r.durationMs)}</TableCell>
                    <TableCell className="text-xs text-red-600 truncate max-w-[400px]">{r.error}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No runs yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
