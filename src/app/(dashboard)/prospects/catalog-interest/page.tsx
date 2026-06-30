"use client";

import { useState } from "react";
import { Mail, Loader2, AlertCircle, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function CatalogInterestPage() {
  const [list, setList] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [runState, setRunState] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/v1/sales/catalog-interest-backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async function runPreview() {
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      const r = await post({ list, dryRun: true });
      if (r.ok) setPreview(r.preview);
      else setError(r.error || "Preview failed");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const poll = async () => {
    try {
      const res = await fetch("/api/v1/sales/catalog-interest-backfill");
      const r = await res.json();
      setRunState(r.state || null);
      if (r.state?.inFlight || r.state?.state === "running") setTimeout(poll, 5000);
      else setBusy(false);
    } catch {
      setBusy(false);
    }
  };

  async function runApply() {
    if (!confirm("Apply: add missing emails, mark these companies interested, and push them to Pipedrive (Catalog Interested). Continue?")) return;
    setBusy(true);
    setError("");
    try {
      const r = await post({ list });
      if (!r.ok && !r.alreadyRunning) {
        setError(r.error || "Failed to start");
        setBusy(false);
        return;
      }
      poll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const fmt = (o: Record<string, unknown> | null) =>
    o
      ? Object.entries(o)
          .filter(([, v]) => typeof v === "number")
          .map(([k, v]) => `${k}: ${(v as number).toLocaleString()}`)
          .join(" · ")
      : "";

  return (
    <div className="container mx-auto p-6 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Mail className="h-7 w-7" />
          Catalog-interest backfill
        </h1>
        <p className="text-muted-foreground mt-2">
          Paste the PhoneBurner follow-up list (one owner email + name per line). Each email is matched to a company
          (exact email, then business domain), the email is added if we don&apos;t have it, the company is marked
          interested, and it&apos;s pushed to Pipedrive (Catalog Interested; AJM contacts stay in AJM). Free-provider
          emails that aren&apos;t already on a contact can&apos;t be matched by domain and are reported for manual review.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Paste list</CardTitle>
          <CardDescription>&quot;email[tab]name&quot; per line; header rows and non-email lines are ignored.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <textarea
            className="w-full h-56 rounded-md border border-input bg-background p-3 text-sm font-mono"
            placeholder="shopthebelle@gmail.com	Shannon&#10;info@shopmoderndress.com	Ashley"
            value={list}
            onChange={(e) => setList(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={runPreview} disabled={busy || !list.trim()}>
              {busy && !runState ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Preview (dry run)
            </Button>
            <Button onClick={runApply} disabled={busy || !list.trim()}>
              {busy && runState ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Apply &amp; push to Pipedrive
            </Button>
          </div>
          {error && (
            <div className="text-sm text-destructive flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              {error}
            </div>
          )}
        </CardContent>
      </Card>

      {preview && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-base">Preview (no writes)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div>{fmt(preview)}</div>
            {Array.isArray(preview.unmatchedSamples) && (preview.unmatchedSamples as string[]).length > 0 && (
              <div className="text-muted-foreground text-xs">
                Unmatched (manual): {(preview.unmatchedSamples as string[]).join(", ")}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {runState && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              {runState.state === "done" ? <CheckCircle className="h-4 w-4 text-green-600" /> : <Loader2 className="h-4 w-4 animate-spin" />}
              {String(runState.state ?? "running")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div>{fmt(runState)}</div>
            {Array.isArray(runState.unmatchedSamples) && (runState.unmatchedSamples as string[]).length > 0 && (
              <div className="text-muted-foreground text-xs">
                Unmatched (manual): {(runState.unmatchedSamples as string[]).join(", ")}
              </div>
            )}
            {runState.error ? <div className="text-destructive">{String(runState.error)}</div> : null}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
