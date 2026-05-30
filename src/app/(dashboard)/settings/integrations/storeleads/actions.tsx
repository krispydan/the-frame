"use client";

/**
 * Client island for the StoreLeads settings page. Two actions:
 *   - Test connection (one cheap GET against StoreLeads)
 *   - CSV upload (drag-drop or file picker; POST multipart to
 *     /api/v1/integrations/storeleads/import-csv)
 *
 * Re-uploading the same file is safe — the importer dedupes by domain
 * and merges (fill nulls, never clobber). The result toast surfaces the
 * full stats so the operator can sanity-check row counts.
 */

import { useRef, useState } from "react";
import { Upload, Wifi, WifiOff, Loader2, FileText } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface ImportStats {
  totalRows: number;
  created: number;
  mergedByDomain: number;
  skippedDuplicate: number;
  skippedNoDomain: number;
  errors: Array<{ row: number; message: string }>;
  durationMs: number;
  categoriesSeen?: Record<string, number>;
}

export function StoreLeadsActions() {
  const [testing, setTesting] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<{ fileName: string; stats: ImportStats } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  async function onTest() {
    setTesting(true);
    try {
      const res = await fetch("/api/v1/integrations/storeleads/test-connection", {
        method: "POST",
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) {
        toast.success("Connected to StoreLeads", {
          description: "API key works and a sample domain lookup succeeded.",
        });
      } else {
        toast.error("Connection failed", { description: data.error });
      }
    } catch (e) {
      toast.error("Test request failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTesting(false);
    }
  }

  async function uploadFile(file: File) {
    setUploading(file.name);
    setLastImport(null);
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch("/api/v1/integrations/storeleads/import-csv", {
        method: "POST",
        body: form,
      });
      const data = (await res.json()) as
        | { ok: true; fileName: string; stats: ImportStats }
        | { ok: false; error: string };
      if (!data.ok) {
        toast.error("Import failed", { description: data.error });
        return;
      }
      setLastImport({ fileName: data.fileName, stats: data.stats });
      toast.success("Import complete", {
        description: `${data.stats.created} created · ${data.stats.mergedByDomain} merged · ${data.stats.skippedDuplicate} dup · ${data.stats.skippedNoDomain} no-domain · ${data.stats.errors.length} errors`,
      });
    } catch (e) {
      toast.error("Upload failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setUploading(null);
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.name.toLowerCase().endsWith(".csv")) {
      void uploadFile(file);
    } else if (file) {
      toast.error("Not a CSV file", { description: file.name });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
        <CardDescription>
          Test the API key, then upload a StoreLeads search-export CSV to merge
          the rows into the CRM. Up to ~10k rows per file; ~5-10s on prod.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={onTest} disabled={testing}>
            {testing ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Wifi className="h-4 w-4 mr-1" />
            )}
            Test connection
          </Button>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`border-2 border-dashed rounded-md p-6 text-center transition-colors ${
            dragging
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/30 hover:border-muted-foreground/50"
          }`}
        >
          {uploading ? (
            <div className="flex items-center justify-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Importing <span className="font-mono">{uploading}</span>…
            </div>
          ) : (
            <>
              <Upload className="h-8 w-8 mx-auto text-muted-foreground/60 mb-2" />
              <p className="text-sm">
                Drop a StoreLeads CSV here, or{" "}
                <button
                  className="underline font-medium"
                  type="button"
                  onClick={() => inputRef.current?.click()}
                >
                  browse
                </button>
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                .csv from any StoreLeads search export
              </p>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void uploadFile(file);
              e.target.value = "";
            }}
          />
        </div>

        {lastImport && (
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <div className="flex items-center gap-2 mb-2 font-medium">
              <FileText className="h-4 w-4" />
              {lastImport.fileName}{" "}
              <span className="text-muted-foreground font-normal">
                ({(lastImport.stats.durationMs / 1000).toFixed(1)}s)
              </span>
            </div>
            <dl className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
              <Stat label="Rows" value={lastImport.stats.totalRows} />
              <Stat label="Created" value={lastImport.stats.created} accent="green" />
              <Stat label="Merged" value={lastImport.stats.mergedByDomain} accent="blue" />
              <Stat label="Skipped" value={lastImport.stats.skippedDuplicate + lastImport.stats.skippedNoDomain} />
              <Stat label="Errors" value={lastImport.stats.errors.length} accent={lastImport.stats.errors.length ? "red" : undefined} />
            </dl>
            {lastImport.stats.categoriesSeen && Object.keys(lastImport.stats.categoriesSeen).length > 0 && (
              <div className="mt-3 text-xs">
                <div className="text-muted-foreground mb-1">Top categories</div>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(lastImport.stats.categoriesSeen)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 8)
                    .map(([cat, n]) => (
                      <span key={cat} className="font-mono bg-background border rounded px-1.5 py-0.5">
                        {cat}{" "}
                        <span className="text-muted-foreground">({n})</span>
                      </span>
                    ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: "green" | "blue" | "red" }) {
  const color =
    accent === "green" ? "text-green-600" : accent === "blue" ? "text-blue-600" : accent === "red" ? "text-red-600" : "";
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className={`font-mono font-semibold ${color}`}>{value.toLocaleString()}</div>
    </div>
  );
}

// Lint quiet — WifiOff isn't currently rendered but is in the lucide set for
// later use (e.g. when we surface "key invalid" inline).
void WifiOff;
