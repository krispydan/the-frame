"use client";

/**
 * Client island for the products table on /settings/integrations/amazon.
 *
 * Hosts:
 *   - The sortable, image-thumbnail table of approved products
 *   - Row-click → right-side Sheet with the inline AmazonListingTab editor
 *   - Bulk selection via checkboxes + a sticky action bar with
 *     "Generate selected" that calls /api/v1/integrations/amazon/generate
 *     once per productId sequentially (client-side loop). That sidesteps
 *     the Cloudflare 100s edge — each call is one product (30–90s) — and
 *     gives the operator per-product progress in toasts.
 *
 * The page is a server component that loads the initial row set and
 * passes it in here. We hydrate, then refetch on demand via /reload.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ImageOff, Sparkles, RefreshCw, X, CheckCircle, AlertTriangle,
  ShieldCheck, Download,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { toast } from "sonner";
import { AmazonListingTab } from "@/app/(dashboard)/catalog/[sku]/amazon-tab";
import {
  ValidationResultsDialog,
  type ProductValidationResult,
  type ValidationSummary,
} from "./validation-results-dialog";

export interface ListingRow {
  id: string;
  skuPrefix: string;
  name: string | null;
  status: string;
  hasListing: boolean;
  generatedAt: string | null;
  modelUsed: string | null;
  amazonTitle: string | null;
  thumbnailUrl: string | null;
}

interface Props {
  initialRows: ListingRow[];
}

export function ListingsTable({ initialRows }: Props) {
  const [rows, setRows] = useState<ListingRow[]>(initialRows);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openProductId, setOpenProductId] = useState<string | null>(null);
  const [batchState, setBatchState] = useState<{ running: boolean; done: number; total: number }>({
    running: false, done: 0, total: 0,
  });
  const [reloadKey, setReloadKey] = useState(0);

  // Refetch the table data without a full page reload. Called after a
  // batch run completes or after a sheet save so the row reflects the
  // newest state (title preview, "Last generated" timestamp).
  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/integrations/amazon/listings", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { rows: ListingRow[] };
      setRows(data.rows);
      setReloadKey((k) => k + 1);
    } catch (e) {
      console.error("[listings-table] reload failed:", e);
    }
  }, []);

  const openRow = useMemo(
    () => rows.find((r) => r.id === openProductId) ?? null,
    [rows, openProductId],
  );

  // Selection helpers
  const allChecked = rows.length > 0 && selected.size === rows.length;
  const someChecked = selected.size > 0 && selected.size < rows.length;
  const toggleAll = () =>
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))));
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const clearSelection = () => setSelected(new Set());

  // Sequentially POST one productId at a time. Each call is well inside
  // Cloudflare's 100s edge; the operator sees per-product progress.
  async function generateForIds(ids: string[], opts: { regenerate: boolean }) {
    if (ids.length === 0) return;
    setBatchState({ running: true, done: 0, total: ids.length });
    let ok = 0;
    let err = 0;
    for (let i = 0; i < ids.length; i++) {
      const productId = ids[i];
      try {
        const res = await fetch("/api/v1/integrations/amazon/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            productIds: [productId],
            limit: 1,
            regenerate: opts.regenerate,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { results: Array<{ status: "ok" | "error"; errors: string[]; title?: string }> };
        const r = data.results[0];
        if (r?.status === "ok") {
          ok++;
        } else {
          err++;
          console.error(`[generate ${productId}] errors:`, r?.errors);
        }
      } catch (e) {
        err++;
        console.error(`[generate ${productId}] failed:`, e);
      }
      setBatchState({ running: true, done: i + 1, total: ids.length });
      // Refresh row state after each one so the table reflects progress.
      void reload();
    }
    setBatchState({ running: false, done: ok + err, total: ids.length });
    if (err === 0) {
      toast.success(`Generated ${ok} listing${ok === 1 ? "" : "s"}`);
    } else {
      toast.warning(`Done — ${ok} succeeded, ${err} errored`, {
        description: "Check the table for which ones still need Generate. Errors are in the browser console.",
        duration: 14000,
      });
    }
  }

  async function onGenerateSelected(regenerate: boolean) {
    const ids = [...selected];
    if (ids.length === 0) return;
    const verb = regenerate ? "Regenerate" : "Generate";
    if (!window.confirm(
      `${verb} ${ids.length} listing${ids.length === 1 ? "" : "s"}?\n\nEach takes 30-90 seconds. ` +
      `Estimated time: ~${Math.ceil((ids.length * 60) / 60)} minutes. ` +
      `Keep this tab open — progress shows below.`,
    )) return;
    clearSelection();
    await generateForIds(ids, { regenerate });
  }

  async function onGenerateAllPending() {
    const pending = rows.filter((r) => !r.hasListing).map((r) => r.id);
    if (pending.length === 0) {
      toast.info("Every product already has a listing.");
      return;
    }
    if (!window.confirm(
      `Generate all ${pending.length} pending listings?\n\nEstimated time: ~${Math.ceil((pending.length * 60) / 60)} minutes. ` +
      `Keep this tab open — progress shows below.`,
    )) return;
    await generateForIds(pending, { regenerate: false });
  }

  const pendingCount = rows.filter((r) => !r.hasListing).length;

  // ── Validate + Download — both honour selection when present, fall back
  //    to "all approved" when nothing checked. The endpoints already
  //    accept productIds; we just gate the request shape.

  const [validating, setValidating] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [validationResults, setValidationResults] = useState<ProductValidationResult[]>([]);
  const [validationSummary, setValidationSummary] = useState<ValidationSummary | null>(null);
  const [validationDialogOpen, setValidationDialogOpen] = useState(false);

  async function onValidate() {
    const ids = selected.size > 0 ? [...selected] : undefined;
    const label = ids ? `${ids.length} selected` : "all approved products";
    setValidating(true);
    try {
      const res = await fetch("/api/v1/integrations/amazon/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ids ? { productIds: ids } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        toast.error("Validation failed", { description: text || `HTTP ${res.status}` });
        return;
      }
      const data = (await res.json()) as {
        results: ProductValidationResult[];
        summary: ValidationSummary;
      };
      const s = data.summary;

      // Stash full results + open the drilldown dialog so the operator
      // sees aggregated reasons + per-product issues, not just counts.
      setValidationResults(data.results ?? []);
      setValidationSummary(s);
      setValidationDialogOpen(true);

      // In grouped mode (Phase 4), prepend the structural counts so the
      // operator sees "7 parents + 192 children" before the
      // ready/warning/blocked breakdown.
      const structural = s.mode === "grouped" && s.parentCount != null && s.childCount != null
        ? `${s.parentCount} parents + ${s.childCount} children`
        : "";
      const description = [
        structural,
        `${s.ready} ready`,
        `${s.warning} warning`,
        `${s.blocked} blocked`,
        s.missingListing ? `${s.missingListing} need AI` : "",
        s.missingImages ? `${s.missingImages} no images` : "",
      ].filter(Boolean).join(" · ");
      if (s.blocked === 0) {
        toast.success(`Validation passed for ${label}`, { description, duration: 8000 });
      } else {
        toast.warning(`${s.blocked} of ${label} blocked — see details`, {
          description,
          duration: 10000,
        });
      }
    } catch (e) {
      toast.error("Validation failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setValidating(false);
    }
  }

  async function onDownload() {
    const ids = selected.size > 0 ? [...selected] : null;
    const label = ids ? `${ids.length} selected` : `all approved`;
    setDownloading(true);
    try {
      const qs = ids ? `?productIds=${encodeURIComponent(ids.join(","))}` : "";
      const res = await fetch(`/api/v1/integrations/amazon/download${qs}`);
      if (res.status === 422) {
        const data = await res.json().catch(() => null) as { blockedProducts?: number; error?: string } | null;
        toast.error("Download blocked by validation", {
          description: data?.blockedProducts != null
            ? `${data.blockedProducts} of ${label} blocked. Click Validate to see details, then fix or regenerate.`
            : data?.error || "Validation failed",
          duration: 14000,
        });
        return;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        toast.error("Download failed", { description: text || `HTTP ${res.status}` });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const scope = ids ? `-${ids.length}prods` : "";
      // Server emits tab-delimited .txt (Amazon's documented format
      // for inventory uploads — see buildAmazonTsvBuffer). The .xlsx
      // round-trip strips macros the validator needs.
      a.download = `jaxy_amazon_${stamp}${scope}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Downloaded spreadsheet for ${label}`);
    } catch (e) {
      toast.error("Download failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setDownloading(false);
    }
  }

  // Disable Download when the user has selected only products that have
  // no listing yet (validation will reject them anyway — better to nudge
  // toward Generate first).
  const selectedAllPending = selected.size > 0 && [...selected].every(
    (id) => !rows.find((r) => r.id === id)?.hasListing,
  );

  return (
    <>
      {/* Action bar: always rendered. Generation / validation / download
          all scope to the current selection — when nothing is checked,
          the buttons fall back to "all approved products" with labels
          that make the scope obvious. */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {selected.size > 0 ? (
          <Badge variant="secondary" className="text-sm">
            {selected.size} selected
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground mr-1">
            No selection — actions run over all approved products. Check rows to scope.
          </span>
        )}

        {/* Generate — selection-aware, falls back to "all pending" */}
        {selected.size > 0 ? (
          <Button size="sm" onClick={() => onGenerateSelected(false)} disabled={batchState.running}>
            <Sparkles className="h-3 w-3 mr-1" />
            Generate {selected.size}
          </Button>
        ) : (
          <Button size="sm" onClick={onGenerateAllPending} disabled={batchState.running || pendingCount === 0}>
            <Sparkles className="h-3 w-3 mr-1" />
            Generate all pending ({pendingCount})
          </Button>
        )}

        {/* Regenerate — only meaningful when products with listings are selected */}
        {selected.size > 0 && (
          <Button size="sm" variant="outline" onClick={() => onGenerateSelected(true)} disabled={batchState.running}>
            <RefreshCw className="h-3 w-3 mr-1" />
            Regenerate {selected.size}
          </Button>
        )}

        <Button size="sm" variant="outline" onClick={onValidate} disabled={validating || batchState.running}>
          <ShieldCheck className={`h-3 w-3 mr-1 ${validating ? "animate-pulse" : ""}`} />
          Validate {selected.size > 0 ? selected.size : "all"}
        </Button>

        {/* Re-open the last results without re-running. Useful when the
            operator dismissed the dialog and wants to revisit. */}
        {validationResults.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setValidationDialogOpen(true)}
            title="Re-open last validation results"
          >
            See last results
          </Button>
        )}

        <Button
          size="sm"
          onClick={onDownload}
          disabled={downloading || batchState.running || selectedAllPending}
          title={selectedAllPending
            ? "Every selected product is still pending — run Generate first."
            : undefined}
        >
          <Download className={`h-3 w-3 mr-1 ${downloading ? "animate-pulse" : ""}`} />
          Download {selected.size > 0 ? `${selected.size} as TXT` : "all"}
        </Button>

        {selected.size > 0 && (
          <Button size="sm" variant="ghost" onClick={clearSelection}>
            <X className="h-3 w-3 mr-1" />
            Clear
          </Button>
        )}
      </div>

      {/* Inline progress bar while a batch is running. */}
      {batchState.running && (
        <div className="mb-3 p-3 border rounded-md bg-muted/30 flex items-center gap-3">
          <RefreshCw className="h-4 w-4 animate-spin text-primary shrink-0" />
          <div className="flex-1">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">Generating listings</span>
              <span className="font-mono text-muted-foreground">
                {batchState.done} / {batchState.total}
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full bg-muted rounded overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${(batchState.done / Math.max(batchState.total, 1)) * 100}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* The table */}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No approved products in the catalog yet.</p>
      ) : (
        <div className="border rounded-md overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox
                    checked={allChecked}
                    aria-label="Select all"
                    onCheckedChange={toggleAll}
                    // Visual hint for partial-state without a dedicated prop
                    className={someChecked ? "data-[state=checked]:bg-primary/50" : undefined}
                  />
                </TableHead>
                <TableHead className="w-20">Image</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="w-24">Status</TableHead>
                <TableHead className="w-32">AI listing</TableHead>
                <TableHead>Title preview</TableHead>
                <TableHead className="w-40">Last generated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, 200).map((p) => {
                const isOpen = openProductId === p.id;
                return (
                  <TableRow
                    key={`${p.id}-${reloadKey}`}
                    className={`${isOpen ? "bg-primary/5" : ""} ${selected.has(p.id) ? "bg-primary/5" : ""} cursor-pointer hover:bg-muted/50 transition-colors`}
                    onClick={(e) => {
                      // Don't open the sheet when the user is targeting the
                      // checkbox — that's a selection action, not a drill-in.
                      const t = e.target as HTMLElement;
                      if (t.closest('[role="checkbox"]')) return;
                      setOpenProductId(p.id);
                    }}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selected.has(p.id)}
                        onCheckedChange={() => toggleOne(p.id)}
                        aria-label={`Select ${p.skuPrefix}`}
                      />
                    </TableCell>
                    <TableCell>
                      {p.thumbnailUrl ? (
                        // object-contain preserves the photo's aspect ratio so
                        // wider-than-tall frames don't get cropped or stretched;
                        // letterbox bg matches the page so it blends. Slightly
                        // taller box than wide gives sunglasses room to breathe.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={p.thumbnailUrl}
                          alt={p.skuPrefix}
                          className="h-12 w-16 object-contain rounded bg-muted"
                          loading="lazy"
                        />
                      ) : (
                        <div className="h-12 w-16 rounded bg-muted flex items-center justify-center">
                          <ImageOff className="h-4 w-4 text-muted-foreground" />
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <div>{p.skuPrefix}</div>
                      <div className="text-muted-foreground truncate max-w-[14rem]">{p.name ?? "—"}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px]">{p.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {p.hasListing ? (
                        <span className="inline-flex items-center gap-1 text-green-600 text-xs">
                          <CheckCircle className="h-3 w-3" /> ready
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-yellow-600 text-xs">
                          <AlertTriangle className="h-3 w-3" /> pending
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <span className="line-clamp-2">{p.amazonTitle ?? "—"}</span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {p.generatedAt ? p.generatedAt.slice(0, 16).replace("T", " ") : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {rows.length > 200 && (
            <p className="text-xs text-muted-foreground p-3 border-t">
              Showing first 200 of {rows.length}. Generate / validate run over the full set regardless.
            </p>
          )}
        </div>
      )}

      {/* Validation drilldown dialog — opens after Validate completes
          when there are blocked or warning issues to surface. */}
      <ValidationResultsDialog
        open={validationDialogOpen}
        onOpenChange={setValidationDialogOpen}
        summary={validationSummary}
        results={validationResults}
        onSelectProduct={(productId) => setOpenProductId(productId)}
        onAfterRepair={() => void reload()}
      />

      {/* Right-side detail sheet hosting the existing inline editor. */}
      <Sheet
        open={openProductId !== null}
        onOpenChange={(o) => {
          if (!o) {
            setOpenProductId(null);
            // When the sheet closes, refresh the table so any save inside
            // the editor flows back into the row (title preview, "Last
            // generated").
            void reload();
          }
        }}
      >
        <SheetContent
          side="right"
          className="w-full sm:max-w-3xl lg:max-w-4xl xl:max-w-5xl flex flex-col gap-0"
        >
          <SheetHeader className="border-b">
            <SheetTitle className="font-mono">
              {openRow?.skuPrefix ?? "…"} — {openRow?.name ?? ""}
            </SheetTitle>
            <SheetDescription>
              {openRow?.hasListing ? "Edit the AI-generated Amazon listing copy." : "No copy generated yet."}
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-4">
            <AmazonListingTab productId={openProductId} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

// Suppress unused-import warning — reserved for the empty-state path
// when we add a "no images" filter chip.
void useEffect;
