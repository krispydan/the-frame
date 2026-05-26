"use client";

/**
 * UPC import card for /settings/integrations/amazon.
 *
 * Sidesteps the clipboard-permission issue (Chrome blocks
 * navigator.clipboard.readText when DevTools is focused) by exposing a
 * native file picker. Drop a ShipHero "Products → Export" CSV, dry-run
 * to see match counts, then click Apply to write the Barcode column
 * into catalog_skus.upc.
 *
 * Posts to /api/v1/catalog/skus/import-upcs which already handles the
 * parsing, header lookup, idempotent updates, and per-row sample/error
 * reporting. This component is purely the operator surface.
 */

import { useRef, useState } from "react";
import {
  Upload, FileSpreadsheet, CheckCircle, AlertTriangle, RefreshCw,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

interface ImportResponse {
  ok: boolean;
  dryRun: boolean;
  totalRows: number;
  matched: number;
  unmatched: number;
  alreadySet: number;
  willUpdate: number;
  blankBarcode: number;
  lengthDistribution: Record<number, number>;
  samples: Array<{
    sku: string; upc: string; length: number;
    action: "unchanged" | "would_update" | "updated" | "no_local_match" | "blank_barcode";
    current?: string | null;
  }>;
  unmatchedSkus: string[];
}

export function UpcImportCard() {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [busy, setBusy] = useState<"none" | "dry" | "apply">("none");

  async function onFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".csv")) {
      toast.error("Only .csv files supported", {
        description: "Use ShipHero's Products → Export.",
      });
      return;
    }
    try {
      const text = await file.text();
      setCsvText(text);
      setFileName(file.name);
      setResult(null);
      // Auto-run a dry-run so the operator sees stats immediately on drop.
      await run(text, true);
    } catch (e) {
      toast.error("Couldn't read file", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function run(text: string, dryRun: boolean) {
    setBusy(dryRun ? "dry" : "apply");
    try {
      const res = await fetch("/api/v1/catalog/skus/import-upcs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: text, dryRun }),
      });

      // Parse defensively — when the route 4xx/5xxs with HTML or empty
      // body, res.json() throws unhelpfully and we lose the real error.
      // Read text first, then attempt JSON, then surface whatever we
      // got so the operator can actually diagnose.
      const rawText = await res.text();
      let data: ImportResponse | { ok: false; error: string } | null = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = null;
      }

      if (!res.ok || !data || (data as { ok?: boolean }).ok === false) {
        const description = data && "error" in data && data.error
          ? data.error
          : rawText
            ? rawText.slice(0, 400)
            : `HTTP ${res.status} ${res.statusText}`;
        console.error("[upc-import] failed", {
          status: res.status,
          statusText: res.statusText,
          rawText: rawText.slice(0, 1000),
        });
        toast.error(`Import failed (HTTP ${res.status})`, {
          description,
          duration: 14000,
        });
        return;
      }
      setResult(data as ImportResponse);
      const d = data as ImportResponse;
      if (dryRun) {
        toast.message("Dry-run complete", {
          description: `${d.matched} matched · ${d.willUpdate} would update · ${d.unmatched} unmatched · ${d.alreadySet} unchanged`,
          duration: 10000,
        });
      } else {
        toast.success(`Imported UPCs`, {
          description: `${d.willUpdate} updated · ${d.alreadySet} unchanged · ${d.unmatched} unmatched`,
          duration: 12000,
        });
      }
    } catch (e) {
      console.error("[upc-import] network/parse error", e);
      toast.error("Import failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy("none");
    }
  }

  function reset() {
    setCsvText(null);
    setFileName(null);
    setResult(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  const lengthEntries = result
    ? Object.entries(result.lengthDistribution).sort((a, b) => Number(a[0]) - Number(b[0]))
    : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <FileSpreadsheet className="h-4 w-4" />
          Import UPCs from ShipHero
        </CardTitle>
        <CardDescription>
          Drop a ShipHero <code>Products → Export</code> CSV to bulk-update <code>catalog_skus.upc</code> from the Barcode column. Required to satisfy Amazon&apos;s <code>external_product_id</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />
          <Button
            size="sm"
            variant={csvText ? "outline" : "default"}
            onClick={() => fileRef.current?.click()}
            disabled={busy !== "none"}
          >
            <Upload className="h-3 w-3 mr-1" />
            {csvText ? "Choose different file" : "Choose CSV file"}
          </Button>

          {csvText && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => csvText && run(csvText, true)}
                disabled={busy !== "none"}
              >
                <RefreshCw className={`h-3 w-3 mr-1 ${busy === "dry" ? "animate-spin" : ""}`} />
                Re-run dry-run
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  if (!csvText) return;
                  if (!result?.willUpdate) {
                    toast.info("Nothing to apply", {
                      description: "Dry-run reported 0 rows that would change.",
                    });
                    return;
                  }
                  if (!window.confirm(
                    `Apply UPC import to production?\n\n` +
                    `${result.willUpdate} SKU${result.willUpdate === 1 ? "" : "s"} will get a new UPC. ` +
                    `${result.alreadySet} unchanged. ${result.unmatched} unmatched (won't be touched).`,
                  )) return;
                  void run(csvText, false);
                }}
                disabled={busy !== "none" || !result || result.willUpdate === 0}
              >
                <CheckCircle className="h-3 w-3 mr-1" />
                Apply ({result?.willUpdate ?? 0})
              </Button>
              <Button size="sm" variant="ghost" onClick={reset} disabled={busy !== "none"}>
                Clear
              </Button>
            </>
          )}
        </div>

        {fileName && (
          <p className="text-xs text-muted-foreground">
            File: <span className="font-mono">{fileName}</span>
            {csvText && ` · ${Math.round(csvText.length / 1024)} KB`}
          </p>
        )}

        {result && (
          <div className="space-y-3 pt-2 border-t">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="outline" className="font-mono">{result.totalRows} rows in CSV</Badge>
              <Badge variant="outline" className="font-mono text-green-600 border-green-200">
                <CheckCircle className="h-3 w-3 mr-1" /> {result.matched} matched
              </Badge>
              <Badge variant="outline" className="font-mono text-blue-600 border-blue-200">
                {result.willUpdate} {result.dryRun ? "would update" : "updated"}
              </Badge>
              <Badge variant="outline" className="font-mono text-muted-foreground">
                {result.alreadySet} unchanged
              </Badge>
              <Badge variant="outline" className="font-mono text-yellow-600 border-yellow-200">
                <AlertTriangle className="h-3 w-3 mr-1" /> {result.unmatched} unmatched
              </Badge>
              {result.blankBarcode > 0 && (
                <Badge variant="outline" className="font-mono text-muted-foreground">
                  {result.blankBarcode} blank
                </Badge>
              )}
            </div>

            {lengthEntries.length > 0 && (
              <div className="text-xs">
                <p className="text-muted-foreground mb-1">Barcode length distribution:</p>
                <div className="flex flex-wrap gap-1">
                  {lengthEntries.map(([len, count]) => {
                    const n = Number(len);
                    const tone = n === 12 || n === 13 || n === 14
                      ? "text-green-700 border-green-200"
                      : "text-yellow-700 border-yellow-200";
                    return (
                      <Badge key={len} variant="outline" className={`font-mono ${tone}`}>
                        {len} chars: {count}
                      </Badge>
                    );
                  })}
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">
                  12-digit = UPC-A, 13 = EAN-13, 14 = GTIN-14 (Amazon accepts all three). Other lengths won&apos;t satisfy Amazon&apos;s <code>external_product_id</code>.
                </p>
              </div>
            )}

            {result.unmatchedSkus.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  {result.unmatchedSkus.length} unmatched SKU{result.unmatchedSkus.length === 1 ? "" : "s"} (in ShipHero but not in catalog)
                </summary>
                <ul className="mt-2 space-y-0.5 max-h-40 overflow-y-auto font-mono">
                  {result.unmatchedSkus.map((s) => (
                    <li key={s} className="text-muted-foreground">{s}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
