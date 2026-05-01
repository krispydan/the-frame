"use client";

import { useEffect, useState } from "react";
import { Loader2, Play, RefreshCw, CheckCircle, AlertCircle, XCircle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";

type SyncRun = {
  id: string;
  kind: string;
  sourcePlatform: string | null;
  status: "running" | "completed" | "failed";
  dateFrom: string | null;
  dateTo: string | null;
  totalPayouts: number | null;
  successful: number | null;
  failed: number | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

function StatusBadge({ status, failed, total }: { status: string; failed: number; total: number }) {
  if (status === "running") return <Badge variant="outline"><Loader2 className="h-3 w-3 mr-1 animate-spin" />Running</Badge>;
  if (status === "failed") return <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />Failed</Badge>;
  if (status === "completed" && failed > 0) return <Badge className="bg-amber-500 hover:bg-amber-600"><AlertCircle className="h-3 w-3 mr-1" />Partial ({total - failed}/{total})</Badge>;
  if (status === "completed") return <Badge className="bg-green-600 hover:bg-green-700"><CheckCircle className="h-3 w-3 mr-1" />Completed</Badge>;
  return <Badge variant="outline"><Clock className="h-3 w-3 mr-1" />{status}</Badge>;
}

function defaultDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

export function XeroPayoutSync() {
  const [runs, setRuns] = useState<SyncRun[] | null>(null);
  const [running, setRunning] = useState(false);
  const [dateFrom, setDateFrom] = useState(defaultDate(14));
  const [dateTo, setDateTo] = useState(defaultDate(0));

  async function loadRuns() {
    const res = await fetch("/api/v1/integrations/xero/sync-runs");
    if (!res.ok) return;
    const data = await res.json();
    setRuns(data.runs || []);
  }

  useEffect(() => { loadRuns(); }, []);

  async function runSync() {
    setRunning(true);
    try {
      const res = await fetch("/api/v1/integrations/xero/sync-payouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateFrom, dateTo }),
      });
      const data = await res.json();
      if (data.failed && data.failed > 0) {
        const firstError = data.errors?.[0]?.message || "see sync run details";
        toast.warning(`Synced ${data.successful} of ${data.totalPayouts} payouts (${data.failed} failed). ${firstError}`);
      } else if (data.totalPayouts === 0) {
        toast.info("No payouts in the selected window.");
      } else if (data.skipped === data.totalPayouts) {
        toast.info(`All ${data.totalPayouts} payouts already synced — nothing new.`);
      } else {
        toast.success(`Synced ${data.successful} payouts to Xero (${data.skipped} already done).`);
      }
      await loadRuns();
    } catch (e) {
      toast.error(`Sync failed: ${e instanceof Error ? e.message : "Unknown"}`);
    } finally {
      setRunning(false);
    }
  }

  const lastSuccess = runs?.find((r) => r.status === "completed" && (r.failed ?? 0) === 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payout sync</CardTitle>
        <CardDescription>
          Pull recent Shopify payouts and post one Xero manual journal per payout. Idempotent — already-synced payouts are skipped.
          {lastSuccess && (
            <>
              {" "}Last clean run: <span className="font-medium">{new Date(lastSuccess.completedAt!).toLocaleString()}</span>.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <Label htmlFor="xero-sync-from" className="text-xs">Date from</Label>
            <Input
              id="xero-sync-from"
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-[160px]"
            />
          </div>
          <div>
            <Label htmlFor="xero-sync-to" className="text-xs">Date to</Label>
            <Input
              id="xero-sync-to"
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-[160px]"
            />
          </div>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={loadRuns}>
            <RefreshCw className="h-3 w-3 mr-1" />Refresh runs
          </Button>
          <Button onClick={runSync} disabled={running}>
            {running ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
            {running ? "Running..." : "Run sync"}
          </Button>
        </div>

        <div>
          <h4 className="text-sm font-medium mb-2">Recent runs</h4>
          {!runs ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sync runs yet. Click Run sync above to start.</p>
          ) : (
            <div className="border rounded-md overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Started</TableHead>
                    <TableHead>Window</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Payouts</TableHead>
                    <TableHead className="text-right">Successful</TableHead>
                    <TableHead className="text-right">Failed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">{r.startedAt ? new Date(r.startedAt).toLocaleString() : "—"}</TableCell>
                      <TableCell className="text-xs">{r.dateFrom} → {r.dateTo}</TableCell>
                      <TableCell><StatusBadge status={r.status} failed={r.failed ?? 0} total={r.totalPayouts ?? 0} /></TableCell>
                      <TableCell className="text-right">{r.totalPayouts ?? 0}</TableCell>
                      <TableCell className="text-right text-green-600">{r.successful ?? 0}</TableCell>
                      <TableCell className="text-right text-red-600">{r.failed ?? 0}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
