"use client";

import { useState } from "react";
import { UploadCloud, Loader2, CheckCircle, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const CHUNK_LINES = 1500;

type Summary = Record<string, unknown>;
type Stats = Record<string, number>;

export default function ImportAjmPage() {
  const [csvText, setCsvText] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [preview, setPreview] = useState<{ stats?: Stats; summary?: Summary } | null>(null);
  const [result, setResult] = useState<{ stats: Stats; summary: Summary } | null>(null);
  const [error, setError] = useState<string>("");
  const [enrichBusy, setEnrichBusy] = useState(false);
  const [enrichResult, setEnrichResult] = useState<Record<string, unknown> | null>(null);
  const [enrichError, setEnrichError] = useState<string>("");

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    setCsvText(await f.text());
    setPreview(null);
    setResult(null);
    setError("");
  }

  async function post(csv: string, dryRun: boolean) {
    const res = await fetch("/api/v1/sales/import-ajm-csv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv, dryRun }),
    });
    return res.json();
  }

  async function runPreview() {
    if (!csvText) return;
    setBusy(true);
    setError("");
    setProgress("Analyzing…");
    try {
      const r = await post(csvText, true);
      if (r.ok) setPreview({ stats: r.stats, summary: r.summary });
      else setError(r.error || "Preview failed");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  async function runImport() {
    if (!csvText) return;
    if (!confirm("Import these AJM leads into the frame? This writes data (idempotent — safe to re-run).")) return;
    setBusy(true);
    setError("");
    setResult(null);

    const lines = csvText.split(/\r?\n/);
    const header = lines[0];
    const dataLines = lines.slice(1).filter((l) => l.trim() !== "");
    const chunks: string[][] = [];
    for (let i = 0; i < dataLines.length; i += CHUNK_LINES) chunks.push(dataLines.slice(i, i + CHUNK_LINES));

    const agg: { stats: Stats; summary: Summary } = { stats: {}, summary: { errors: [] } };
    const add = (target: Record<string, number>, src: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(src)) if (typeof v === "number") target[k] = (target[k] || 0) + v;
    };

    try {
      for (let i = 0; i < chunks.length; i++) {
        setProgress(`Importing chunk ${i + 1} / ${chunks.length}…`);
        const r = await post(header + "\n" + chunks[i].join("\n"), false);
        if (!r.ok) throw new Error(r.error || `chunk ${i + 1} failed`);
        if (r.stats) add(agg.stats, r.stats);
        if (r.summary) {
          add(agg.summary as Record<string, number>, r.summary);
          if (Array.isArray(r.summary.errors)) (agg.summary.errors as unknown[]).push(...r.summary.errors);
        }
        setResult({ ...agg });
      }
      setProgress("Done.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const pollEnrich = async () => {
    try {
      const res = await fetch("/api/v1/sales/enrich-ajm");
      const r = await res.json();
      setEnrichResult((r.state as Record<string, unknown>) || null);
      if (r.inFlight || (r.state && r.state.state === "running")) {
        setTimeout(pollEnrich, 5000);
      } else {
        setEnrichBusy(false);
      }
    } catch {
      setEnrichBusy(false);
    }
  };

  async function startEnrich() {
    setEnrichBusy(true);
    setEnrichError("");
    try {
      const res = await fetch("/api/v1/sales/enrich-ajm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const r = await res.json();
      if (!r.ok && !r.alreadyRunning) {
        setEnrichError(r.error || "Failed to start enrichment");
        setEnrichBusy(false);
        return;
      }
      pollEnrich();
    } catch (e) {
      setEnrichError(e instanceof Error ? e.message : String(e));
      setEnrichBusy(false);
    }
  }

  const fmt = (o: Record<string, unknown> | undefined) =>
    o
      ? Object.entries(o)
          .filter(([, v]) => typeof v === "number")
          .map(([k, v]) => `${k}: ${(v as number).toLocaleString()}`)
          .join(" · ")
      : "";

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <UploadCloud className="h-7 w-7" />
          Import AJM leads
        </h1>
        <p className="text-muted-foreground mt-2">
          Upload the AJM customer CSV. Rows are cleaned on import: company / contact / address fields title-cased,
          emails de-spaced and validated (junk dropped), website pulled from the Website column, zips fixed.
          Idempotent — re-running merges, never duplicates.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Choose file</CardTitle>
          <CardDescription>CSV or tab-separated, with the header row (Company, ATTN, ADDRESS, …).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <input type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values,text/plain" onChange={onFile} className="text-sm" />
          {fileName && <div className="text-sm text-muted-foreground">{fileName} loaded ({csvText.split(/\r?\n/).length - 1} rows)</div>}

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={runPreview} disabled={busy || !csvText}>
              {busy && progress === "Analyzing…" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Preview (dry run)
            </Button>
            <Button onClick={runImport} disabled={busy || !csvText}>
              {busy && progress.startsWith("Importing") ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Import for real
            </Button>
          </div>

          {progress && <div className="text-sm text-muted-foreground">{progress}</div>}
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
            <div><span className="text-muted-foreground">Cleanup:</span> {fmt(preview.stats)}</div>
            {preview.summary && <div><span className="text-muted-foreground">Would import:</span> {fmt(preview.summary)}</div>}
          </CardContent>
        </Card>
      )}

      {result && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-600" />
              Import result
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div><span className="text-muted-foreground">Cleanup:</span> {fmt(result.stats)}</div>
            <div><span className="text-muted-foreground">Imported:</span> {fmt(result.summary)}</div>
            {Array.isArray(result.summary.errors) && result.summary.errors.length > 0 && (
              <div className="text-destructive">{result.summary.errors.length} row error(s)</div>
            )}
            <p className="text-xs text-muted-foreground pt-2 border-t">
              Next: enrich these with website / hours / open-status via Google Maps (below).
            </p>
          </CardContent>
        </Card>
      )}

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">2. Enrich via Google Maps (Apify)</CardTitle>
          <CardDescription>
            Fills website + business hours, adds Google rating, and marks permanently-closed stores for the AJM
            cohort. Enable the <code>ajm-gmaps-enrich</code> cron to run automatically (~40/run), or run a batch now.
            Apify cost ≈ $2-3 per 1,000.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button variant="outline" onClick={startEnrich} disabled={enrichBusy}>
            {enrichBusy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            {enrichBusy ? "Enriching… (runs in background)" : "Enrich AJM now"}
          </Button>
          {enrichResult && (
            <div className="text-sm">
              <span className="text-muted-foreground">{String(enrichResult.state ?? "")}:</span>{" "}
              {Object.entries(enrichResult)
                .filter(([k, v]) => typeof v === "number")
                .map(([k, v]) => `${k}: ${(v as number).toLocaleString()}`)
                .join(" · ") || "—"}
              {enrichResult.error ? ` · ${String(enrichResult.error)}` : ""}
            </div>
          )}
          {enrichError && (
            <div className="text-sm text-destructive flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              {enrichError}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
