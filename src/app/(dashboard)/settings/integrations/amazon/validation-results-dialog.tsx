"use client";

/**
 * Validation results dialog — opens after a Validate run completes and
 * shows the per-product issues the toast summary couldn't fit.
 *
 * Surfaces are designed for the "0 ready · 39 blocked" panic case: the
 * top section groups blocked issues by message so the operator can see
 * "37 products missing item_name" rather than just a count. The product
 * list below lets them jump straight into the row's editor sheet to
 * fix.
 *
 * Wired by ListingsTable. The table calls /validate, stashes the
 * results array, and pops this dialog with onSelectProduct = opening
 * the existing detail sheet.
 */

import { useMemo, useState } from "react";
import {
  AlertTriangle, CheckCircle, AlertCircle, X, ExternalLink, Sparkles,
  ChevronRight, ChevronDown,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";

export interface ValidationIssue {
  field: string;
  message: string;
  severity: "blocked" | "warning";
}

export interface ProductValidationResult {
  productId: string;
  productName: string;
  skuPrefix: string;
  status: "ready" | "blocked" | "warning";
  issues: ValidationIssue[];
  skuResults: Array<{
    skuId: string;
    sku: string;
    status: "ready" | "blocked" | "warning";
    issues: ValidationIssue[];
  }>;
}

export interface ValidationSummary {
  ready: number;
  warning: number;
  blocked: number;
  missingListing?: number;
  missingImages?: number;
  /** Phase 4 group-restructure: distinguishes feed shape so the
   *  toast and dialog can show "7 parents + 192 children" instead
   *  of treating each composed entry as one product. */
  mode?: "grouped" | "per-product";
  parentCount?: number;
  childCount?: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: ValidationSummary | null;
  results: ProductValidationResult[];
  onSelectProduct: (productId: string) => void;
  /** Called after the user confirms an auto-fix batch. The parent table
   *  refreshes its row data + reopens validation when fixing completes. */
  onAfterRepair?: () => void;
}

/** Flatten a product's parent + child issues into short, AI-friendly
 *  constraint strings. Dedups by (field, message). Skips issues the AI
 *  can't fix on its own (UPC missing, etc.) — those need data action. */
function repairableIssueStrings(p: ProductValidationResult): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const collect = (issue: ValidationIssue, scope: string) => {
    // Anything tied to required_external_product_id etc. needs UPC data,
    // not creativity. Skip those — they won't change on re-generation.
    if (issue.field.includes("external_product_id")) return;
    const key = `${scope}|${issue.field}|${issue.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(`${scope === "parent" ? "" : `(SKU ${scope}) `}${issue.field}: ${issue.message}`);
  };
  for (const i of p.issues) collect(i, "parent");
  for (const sr of p.skuResults) for (const i of sr.issues) collect(i, sr.sku);
  return out;
}

export function ValidationResultsDialog({
  open, onOpenChange, summary, results, onSelectProduct, onAfterRepair,
}: Props) {
  const [repairing, setRepairing] = useState(false);
  const [repairingProductId, setRepairingProductId] = useState<string | null>(null);
  // Tracks which product rows are expanded to show issue detail.
  // Click the chevron (or anywhere in the status/product cell) to
  // toggle. Warning-only rows tend to share the same kind of issue,
  // but expanding shows the exact field + message for each.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpanded(productId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  }

  async function runRepair(products: ProductValidationResult[]) {
    if (products.length === 0) return;
    // Build the per-product issues map. If everything in a product was
    // unfixable (missing UPCs only), drop it.
    const repairIssues: Record<string, string[]> = {};
    const candidates: ProductValidationResult[] = [];
    for (const p of products) {
      const issues = repairableIssueStrings(p);
      if (issues.length > 0) {
        repairIssues[p.productId] = issues;
        candidates.push(p);
      }
    }
    if (candidates.length === 0) {
      toast.info("Nothing AI-fixable", {
        description: "All issues require data action (e.g. add a UPC, fix a tag). Edit each product directly.",
      });
      return;
    }

    setRepairing(true);
    let processed = 0;
    let errors = 0;
    try {
      // Drive sequentially per-product (each Claude vision call is
      // 30-90s; we want progress visibility and to stay under
      // Cloudflare's edge timeout per request).
      for (const c of candidates) {
        setRepairingProductId(c.productId);
        try {
          const res = await fetch("/api/v1/integrations/amazon/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              productIds: [c.productId],
              regenerate: true,
              repairIssues: { [c.productId]: repairIssues[c.productId] },
            }),
          });
          if (!res.ok) {
            errors++;
            console.error(`[repair] ${c.skuPrefix} HTTP ${res.status}`);
          } else {
            const data = (await res.json()) as { results: Array<{ status: "ok" | "error"; errors?: string[] }> };
            if (data.results[0]?.status === "ok") processed++;
            else errors++;
          }
        } catch (e) {
          errors++;
          console.error(`[repair] ${c.skuPrefix} threw:`, e);
        }
      }
      const msg = `${processed} fixed, ${errors} errored. Re-validate to confirm.`;
      if (errors === 0) {
        toast.success("AI repair complete", { description: msg, duration: 10000 });
      } else {
        toast.warning("AI repair partial", { description: msg, duration: 12000 });
      }
      // Close the dialog so the operator can click Validate again to
      // see the new state, and let the parent know to refresh rows.
      onOpenChange(false);
      if (onAfterRepair) onAfterRepair();
    } finally {
      setRepairing(false);
      setRepairingProductId(null);
    }
  }
  // Aggregate blocked issues by (field, message) so "37 missing
  // item_name" surfaces once instead of 37 row-level repeats.
  const aggregated = useMemo(() => {
    type Bucket = { field: string; message: string; severity: "blocked" | "warning"; count: number; productIds: Set<string> };
    const map = new Map<string, Bucket>();
    for (const product of results) {
      // Collect parent + sku issues, dedup per product.
      const seenForProduct = new Set<string>();
      const allIssues: ValidationIssue[] = [
        ...product.issues,
        ...product.skuResults.flatMap((s) => s.issues),
      ];
      for (const issue of allIssues) {
        // Dedup by (field|message), not by exact value — empirically the
        // same issue often repeats per-SKU but it's one product-level
        // problem.
        const key = `${issue.severity}|${issue.field}|${issue.message}`;
        if (seenForProduct.has(key)) continue;
        seenForProduct.add(key);
        const bucket = map.get(key) ?? {
          field: issue.field,
          message: issue.message,
          severity: issue.severity,
          count: 0,
          productIds: new Set<string>(),
        };
        bucket.count++;
        bucket.productIds.add(product.productId);
        map.set(key, bucket);
      }
    }
    return [...map.values()].sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === "blocked" ? -1 : 1;
      return b.count - a.count;
    });
  }, [results]);

  const blockedProducts = useMemo(
    () => results.filter((r) => r.status === "blocked"),
    [results],
  );
  const warningProducts = useMemo(
    () => results.filter((r) => r.status === "warning"),
    [results],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Wide + tall so the per-product table and the issues-by-reason
        // section both fit without horizontal scrolling. `!max-w-*` to
        // override the default `sm:max-w-lg` that the Dialog component
        // sets via its base class — without `!important` the smaller
        // default wins on >=640px viewports. The +none cap on the right
        // is for ultra-wide monitors so the dialog doesn't sprawl to
        // 2000px.
        className="!max-w-[min(1280px,95vw)] !w-[min(1280px,95vw)] max-h-[92vh] h-[92vh] overflow-hidden flex flex-col p-6 sm:p-8"
      >
        <DialogHeader>
          <DialogTitle>Validation results</DialogTitle>
          <DialogDescription>
            {summary && (
              <>
                <span className="font-mono">{summary.ready}</span> ready ·{" "}
                <span className="font-mono">{summary.warning}</span> warning ·{" "}
                <span className="font-mono">{summary.blocked}</span> blocked
                {summary.missingListing != null && summary.missingListing > 0 && (
                  <> · <span className="font-mono">{summary.missingListing}</span> need AI listing</>
                )}
                {summary.missingImages != null && summary.missingImages > 0 && (
                  <> · <span className="font-mono">{summary.missingImages}</span> have no images</>
                )}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto space-y-6 pr-2">
          {/* Aggregated issue reasons */}
          {aggregated.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold mb-2">Issues by reason</h3>
              <p className="text-xs text-muted-foreground mb-3">
                Each row is one issue type and how many products have it. Fix the most-common ones first — usually that&apos;s &quot;run Generate&quot; for missing AI fields.
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-24">Severity</TableHead>
                    <TableHead className="w-56">Field</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead className="w-24 text-right">Affects</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {aggregated.map((bucket) => (
                    <TableRow key={`${bucket.field}|${bucket.message}|${bucket.severity}`}>
                      <TableCell>
                        {bucket.severity === "blocked" ? (
                          <Badge variant="destructive" className="text-[10px]">
                            <AlertTriangle className="h-2.5 w-2.5 mr-1" /> Blocked
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] border-yellow-300 text-yellow-700">
                            <AlertCircle className="h-2.5 w-2.5 mr-1" /> Warning
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{bucket.field}</TableCell>
                      <TableCell className="text-sm">{bucket.message}</TableCell>
                      <TableCell className="text-right font-mono">{bucket.count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          )}

          {/* Per-product drilldown — blocked first, then warning */}
          {(blockedProducts.length > 0 || warningProducts.length > 0) && (
            <section>
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-sm font-semibold">Per-product</h3>
                {blockedProducts.length > 0 && (
                  <Button
                    size="sm"
                    onClick={() => {
                      if (!window.confirm(
                        `Auto-fix ${blockedProducts.length} blocked product${blockedProducts.length === 1 ? "" : "s"} with AI?\n\n` +
                        `Claude will regenerate each listing with the validation issues injected as constraints. ` +
                        `Each takes 30-90 seconds (~${Math.ceil(blockedProducts.length * 60 / 60)} min total). ` +
                        `Re-validate when complete to confirm. ` +
                        `Products whose only issue is missing data (UPC, etc.) won't be touched — those need a manual fix.`,
                      )) return;
                      void runRepair(blockedProducts);
                    }}
                    disabled={repairing}
                  >
                    <Sparkles className={`h-3 w-3 mr-1 ${repairing ? "animate-pulse" : ""}`} />
                    Auto-fix all blocked ({blockedProducts.length})
                  </Button>
                )}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-32">Status</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="w-32">Issues</TableHead>
                    <TableHead className="w-48 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...blockedProducts, ...warningProducts].flatMap((p) => {
                    const totalIssues =
                      p.issues.length + p.skuResults.reduce((s, sr) => s + sr.issues.length, 0);
                    const blockedCount =
                      p.issues.filter((i) => i.severity === "blocked").length +
                      p.skuResults.reduce(
                        (s, sr) => s + sr.issues.filter((i) => i.severity === "blocked").length,
                        0,
                      );
                    const isExpanded = expanded.has(p.productId);
                    // Build the flat issue list once so the expansion row
                    // can render without recomputing on every keystroke.
                    const allIssues: Array<{
                      scope: string;
                      field: string;
                      message: string;
                      severity: "blocked" | "warning";
                    }> = [
                      ...p.issues.map((i) => ({ scope: "parent", ...i })),
                      ...p.skuResults.flatMap((sr) =>
                        sr.issues.map((i) => ({ scope: sr.sku, ...i })),
                      ),
                    ];
                    return [
                      <TableRow
                        key={p.productId}
                        className="cursor-pointer hover:bg-muted/40"
                        onClick={() => toggleExpanded(p.productId)}
                      >
                        <TableCell>
                          <div className="flex items-center gap-1">
                            {isExpanded ? (
                              <ChevronDown className="h-3 w-3 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-3 w-3 text-muted-foreground" />
                            )}
                            {p.status === "blocked" ? (
                              <Badge variant="destructive" className="text-[10px]">
                                <AlertTriangle className="h-2.5 w-2.5 mr-1" /> Blocked
                              </Badge>
                            ) : p.status === "warning" ? (
                              <Badge variant="outline" className="text-[10px] border-yellow-300 text-yellow-700">
                                <AlertCircle className="h-2.5 w-2.5 mr-1" /> Warning
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-[10px] text-green-700 border-green-300">
                                <CheckCircle className="h-2.5 w-2.5 mr-1" /> Ready
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="font-medium text-sm">{p.productName}</div>
                          <div className="text-xs text-muted-foreground font-mono">{p.skuPrefix}</div>
                        </TableCell>
                        <TableCell>
                          <div className="text-xs">
                            {blockedCount > 0 && (
                              <span className="text-red-600 font-mono">{blockedCount} blocked</span>
                            )}
                            {blockedCount > 0 && totalIssues - blockedCount > 0 && " · "}
                            {totalIssues - blockedCount > 0 && (
                              <span className="text-yellow-700 font-mono">
                                {totalIssues - blockedCount} warn
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            {p.status === "blocked" && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={repairing}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (!window.confirm(
                                    `Auto-fix ${p.productName} (${p.skuPrefix}) with AI?\n\n` +
                                    `Claude will regenerate the listing with these validation issues as constraints. Takes 30-90 seconds.`,
                                  )) return;
                                  void runRepair([p]);
                                }}
                                title="Re-generate with validation issues injected"
                              >
                                <Sparkles
                                  className={`h-3 w-3 mr-1 ${
                                    repairing && repairingProductId === p.productId ? "animate-pulse" : ""
                                  }`}
                                />
                                Fix
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                onSelectProduct(p.productId);
                                onOpenChange(false);
                              }}
                              title="Open product to fix manually"
                            >
                              <ExternalLink className="h-3 w-3" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>,
                      // Expanded detail row — only renders when this product
                      // is open. colSpan 4 fills the full width with a
                      // compact issue list. Each issue shows scope (parent
                      // or SKU), the field, a severity dot, and the
                      // message; clicking opens the product editor at the
                      // exact field where possible.
                      isExpanded ? (
                        <TableRow key={`${p.productId}-expanded`} className="bg-muted/30">
                          <TableCell colSpan={4} className="py-3">
                            {allIssues.length === 0 ? (
                              <p className="text-xs text-muted-foreground">No issues — this product is release-ready.</p>
                            ) : (
                              <div className="space-y-1">
                                {allIssues.map((issue, i) => (
                                  <div
                                    key={i}
                                    className="grid grid-cols-[80px_120px_1fr] gap-3 text-xs items-start"
                                  >
                                    <span className={`font-mono ${issue.scope === "parent" ? "text-muted-foreground" : "text-blue-600"}`}>
                                      {issue.scope}
                                    </span>
                                    <span className="font-mono text-muted-foreground truncate" title={issue.field}>
                                      {issue.field}
                                    </span>
                                    <span className="flex items-start gap-1.5">
                                      {issue.severity === "blocked" ? (
                                        <AlertTriangle className="h-3 w-3 text-red-500 mt-0.5 shrink-0" />
                                      ) : (
                                        <AlertCircle className="h-3 w-3 text-yellow-600 mt-0.5 shrink-0" />
                                      )}
                                      <span className={issue.severity === "blocked" ? "text-red-700" : "text-yellow-800"}>
                                        {issue.message}
                                      </span>
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      ) : null,
                    ].filter(Boolean);
                  })}
                </TableBody>
              </Table>
            </section>
          )}

          {/* Empty state — everything ready */}
          {blockedProducts.length === 0 && warningProducts.length === 0 && results.length > 0 && (
            <div className="text-center py-8">
              <CheckCircle className="h-10 w-10 text-green-500 mx-auto mb-2" />
              <p className="font-medium">All {results.length} products are ready to download.</p>
              <p className="text-sm text-muted-foreground mt-1">
                No blocking issues. Click Download to generate the spreadsheet.
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            <X className="h-3 w-3 mr-1" /> Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
