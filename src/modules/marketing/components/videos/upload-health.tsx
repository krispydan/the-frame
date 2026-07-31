"use client";

/**
 * Upload health — what actually happened to everything that was uploaded.
 *
 * Uploads fail quietly: a toast disappears, a normalize job dies, a
 * /register call never lands and the bytes sit in R2 with nothing
 * pointing at them. This panel is the standing answer to "did all my
 * clips make it?", and its Fix button re-runs the work in place —
 * nothing here asks the operator to re-upload footage the system
 * already has.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Wrench } from "lucide-react";

interface BrokenRow {
  kind: "clip" | "source";
  id: string;
  fileName: string;
  status: string;
  error: string | null;
  repairable: boolean;
}
interface Report {
  clips: { total: number; ready: number; failed: number; stuck: number };
  sources: { total: number; done: number; failed: number; stuck: number; emptyDone: number };
  broken: BrokenRow[];
  orphans: Array<{ kind: string; path: string; sizeBytes: number }>;
  orphansTruncated: boolean;
}

const API = "/api/v1/marketing/videos/uploads";

export function UploadHealth({ onChanged }: { onChanged?: () => void }) {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [fixing, setFixing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/report`);
      setReport(res.ok ? ((await res.json()) as Report) : null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`${API}/report`).catch(() => null);
      const data = res?.ok ? ((await res.json()) as Report) : null;
      if (cancelled) return;
      setReport(data);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const fixAll = async () => {
    setFixing(true);
    const res = await fetch(`${API}/repair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    const d = await res.json().catch(() => ({}));
    setFixing(false);
    if (!res.ok) {
      toast.error(d.error ?? "Repair failed");
      return;
    }
    const parts: string[] = [];
    if (d.requeued) parts.push(`${d.requeued} re-queued`);
    if (d.adopted) parts.push(`${d.adopted} recovered from storage`);
    if (d.skipped) parts.push(`${d.skipped} need re-uploading`);
    toast.success(parts.length > 0 ? parts.join(" · ") : "Nothing to fix");
    if (d.adopted > 0) {
      toast.message("Recovered files came back untagged — set their category and products in the library.", {
        duration: 10000,
      });
    }
    await load();
    onChanged?.();
  };

  if (loading) return <div className="h-24 animate-pulse rounded-lg bg-muted" />;
  if (!report) return null;

  const needsUpload = report.broken.filter((b) => !b.repairable);
  const repairable = report.broken.filter((b) => b.repairable);
  const problems = report.broken.length + report.orphans.length;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {problems === 0 ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-amber-600" />
          )}
          <span className="font-medium text-sm">Upload health</span>
          <span className="text-xs text-muted-foreground">
            {report.clips.ready} clips ready · {report.sources.done} videos clipped
          </span>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={load}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          {(repairable.length > 0 || report.orphans.length > 0) && (
            <Button size="sm" onClick={fixAll} disabled={fixing}>
              {fixing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Wrench className="h-4 w-4 mr-1" />}
              Fix {repairable.length + report.orphans.length} in place
            </Button>
          )}
        </div>

        {problems === 0 ? (
          <p className="text-xs text-muted-foreground">
            Everything that was uploaded made it through. Nothing to re-upload.
          </p>
        ) : (
          <div className="space-y-2 text-xs">
            {repairable.length > 0 && (
              <p className="text-muted-foreground">
                <strong className="text-foreground">{repairable.length}</strong> upload
                {repairable.length === 1 ? "" : "s"} failed processing but the file is still stored — these
                just need re-running, not re-uploading.
              </p>
            )}
            {report.orphans.length > 0 && (
              <p className="text-muted-foreground">
                <strong className="text-foreground">{report.orphans.length}</strong>
                {report.orphansTruncated ? "+" : ""} file
                {report.orphans.length === 1 ? "" : "s"} reached storage but were never recorded — Fix claims
                them (they come back untagged).
              </p>
            )}
            {needsUpload.length > 0 && (
              <div>
                <p className="text-muted-foreground">
                  <strong className="text-foreground">{needsUpload.length}</strong> genuinely need re-uploading
                  — the file is gone:
                </p>
                <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
                  {needsUpload.slice(0, 50).map((b) => (
                    <li key={`${b.kind}-${b.id}`} className="flex items-center gap-2">
                      <Badge variant="outline" className="shrink-0">{b.kind}</Badge>
                      <span className="truncate font-mono">{b.fileName}</span>
                      <span className="shrink-0 text-muted-foreground">{b.error ?? b.status}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-muted-foreground">
              Re-dropping the whole folder in the uploader is safe — anything already here is skipped.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
