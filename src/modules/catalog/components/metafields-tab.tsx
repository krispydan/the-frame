"use client";

import { useState, useCallback, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RefreshCw, Send, Save, Loader2, Tags, CheckCircle2, AlertCircle, Sparkles } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

interface AiCategorization {
  seo: { title: string; description: string };
  category_metafields: {
    color_pattern: string[];
    eyewear_frame_color: string[];
    lens_color: string[];
    age_group: string;
    lens_polarization: string;
    target_gender: string;
    eyewear_frame_design: string;
  };
}

interface MetafieldsTabProps {
  productId: string;
  aiCategorization: string | null;
  aiCategorizedAt: string | null;
  aiCategorizationModel: string | null;
  onRefresh: () => void;
}

/** Response shape from POST /products/:id/generate-seo */
interface SeoPreview {
  productId: string;
  skuPrefix: string;
  productName: string | null;
  model: string;
  current: { title: string | null; description: string | null };
  generated: {
    title: string;
    description: string;
    keywords_used: string[];
    char_count: { title: number; description: number };
  };
  warnings: string[];
}

/** Response shape from POST /products/:id/sync-shopify-metafields-from-tags */
interface TagSyncResponse {
  ok: boolean;
  productId: string;
  skuPrefix: string;
  productName: string | null;
  dryRun: boolean;
  stores: Array<{
    ok: boolean;
    store: "dtc" | "wholesale";
    skuPrefix: string;
    shopifyProductId: string | null;
    resolved: Array<{ field: string; handle: string; gid: string | null; source: string | null }>;
    mappingWarnings: string[];
    metafieldsAttempted: number;
    metafieldsWritten: number;
    metafieldErrors: string[];
    skipReasons: Array<{ field: string; reason: string }>;
  }>;
}

const METAFIELD_LABELS: Record<string, string> = {
  color_pattern: "Color/Pattern",
  eyewear_frame_color: "Frame Color",
  lens_color: "Lens Color",
  age_group: "Age Group",
  lens_polarization: "Lens Polarization",
  target_gender: "Target Gender",
  eyewear_frame_design: "Frame Design",
};

export function MetafieldsTab({
  productId,
  aiCategorization,
  aiCategorizedAt,
  aiCategorizationModel,
  onRefresh,
}: MetafieldsTabProps) {
  const [categorizing, setCategorizing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [savingSeo, setSavingSeo] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  // Tag-curated sync (separate flow from the AI-driven sync above).
  // Pushes the 4 metafields the user curates via tags:
  //   shopify.lens-polarization, shopify.eyewear-frame-design,
  //   shopify.target-gender, shopify.color-pattern (+ custom.frame_shape).
  const [tagSyncStore, setTagSyncStore] = useState<"both" | "dtc" | "wholesale">("both");
  const [tagSyncing, setTagSyncing] = useState(false);
  const [tagSyncResult, setTagSyncResult] = useState<TagSyncResponse | null>(null);
  const [tagSyncError, setTagSyncError] = useState<string | null>(null);

  // Google Shopping SEO (Simprosys feed reads from Shopify product seo
  // title + description on retail). Preview-then-save flow.
  const [seoGenerating, setSeoGenerating] = useState(false);
  const [seoSaving, setSeoSaving] = useState(false);
  const [seoPreview, setSeoPreview] = useState<SeoPreview | null>(null);
  const [seoError, setSeoError] = useState<string | null>(null);
  const [seoSaved, setSeoSaved] = useState<string | null>(null);

  // Parse the JSON blob
  let parsed: AiCategorization | null = null;
  try {
    if (aiCategorization) parsed = JSON.parse(aiCategorization);
  } catch {
    /* invalid JSON — show "not categorized" */
  }

  const [seoTitle, setSeoTitle] = useState(parsed?.seo?.title ?? "");
  const [seoDescription, setSeoDescription] = useState(parsed?.seo?.description ?? "");

  // Keep SEO fields in sync when parent data changes
  useEffect(() => {
    let p: AiCategorization | null = null;
    try { if (aiCategorization) p = JSON.parse(aiCategorization); } catch { /* */ }
    setSeoTitle(p?.seo?.title ?? "");
    setSeoDescription(p?.seo?.description ?? "");
  }, [aiCategorization]);

  const handleRecategorize = async () => {
    setCategorizing(true);
    try {
      const res = await fetch("/api/v1/catalog/shopify-metafields-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productIds: [productId],
          stores: [],
          dryRun: true,
          force: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSyncResult(`Error: ${data.error || res.statusText}`);
      } else {
        setSyncResult("Re-categorized. Refresh to see updated data.");
        onRefresh();
      }
    } catch (err) {
      setSyncResult(`Error: ${err instanceof Error ? err.message : "unknown"}`);
    }
    setCategorizing(false);
  };

  const handleSyncToShopify = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/v1/catalog/shopify-metafields-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productIds: [productId],
          stores: ["dtc", "wholesale"],
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSyncResult(`Sync error: ${data.error || res.statusText}`);
      } else {
        const results = data.results || [];
        const ok = results.filter((r: { status: string }) => r.status === "ok").length;
        const errs = results.filter((r: { status: string }) => r.status !== "ok").length;
        setSyncResult(`Synced: ${ok} success, ${errs} errors`);
        onRefresh();
      }
    } catch (err) {
      setSyncResult(`Error: ${err instanceof Error ? err.message : "unknown"}`);
    }
    setSyncing(false);
  };

  const handleGenerateSeo = async () => {
    setSeoGenerating(true);
    setSeoError(null);
    setSeoSaved(null);
    setSeoPreview(null);
    try {
      const res = await fetch(`/api/v1/catalog/products/${productId}/generate-seo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        setSeoError(data.error || `HTTP ${res.status}`);
      } else {
        setSeoPreview(data as SeoPreview);
      }
    } catch (err) {
      setSeoError(err instanceof Error ? err.message : "unknown");
    }
    setSeoGenerating(false);
  };

  const handleSaveSeoNew = async (title: string, description: string) => {
    setSeoSaving(true);
    setSeoError(null);
    setSeoSaved(null);
    try {
      const res = await fetch(`/api/v1/catalog/products/${productId}/save-seo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setSeoError(data.shopifyRetail?.error || data.error || `HTTP ${res.status}`);
      } else {
        setSeoSaved(`Saved + pushed to retail (Shopify product ${data.shopifyRetail.productId})`);
        setSeoPreview(null);
        onRefresh();
      }
    } catch (err) {
      setSeoError(err instanceof Error ? err.message : "unknown");
    }
    setSeoSaving(false);
  };

  const handleTagSync = async () => {
    setTagSyncing(true);
    setTagSyncError(null);
    setTagSyncResult(null);
    try {
      const stores = tagSyncStore === "both" ? ["dtc", "wholesale"] : [tagSyncStore];
      const res = await fetch(
        `/api/v1/catalog/products/${productId}/sync-shopify-metafields-from-tags`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stores }),
        },
      );
      const data = (await res.json()) as TagSyncResponse | { error: string };
      if ("error" in data) {
        setTagSyncError(data.error);
      } else {
        setTagSyncResult(data);
      }
    } catch (err) {
      setTagSyncError(err instanceof Error ? err.message : "unknown");
    }
    setTagSyncing(false);
  };

  const handleSaveAiCategorizationSeo = async () => {
    if (!parsed) return;
    setSavingSeo(true);
    const updated = {
      ...parsed,
      seo: { title: seoTitle, description: seoDescription },
    };
    await fetch(`/api/v1/catalog/products/${productId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aiCategorization: JSON.stringify(updated) }),
    });
    setSavingSeo(false);
    onRefresh();
  };

  const metafields = parsed?.category_metafields;

  return (
    <div className="space-y-4">
      {/* Status row */}
      <Card>
        <CardContent className="p-4 flex items-center justify-between">
          <div className="text-sm">
            {parsed ? (
              <span>
                Last categorized:{" "}
                <span className="font-medium">
                  {aiCategorizedAt
                    ? new Date(aiCategorizedAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "unknown date"}
                </span>
                {aiCategorizationModel && (
                  <span className="text-muted-foreground"> by {aiCategorizationModel}</span>
                )}
              </span>
            ) : (
              <span className="text-muted-foreground">Not yet categorized</span>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleRecategorize}
              disabled={categorizing}
            >
              {categorizing ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3 mr-1" />
              )}
              Re-categorize
            </Button>
            <Button
              size="sm"
              onClick={handleSyncToShopify}
              disabled={syncing || !parsed}
            >
              {syncing ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Send className="h-3 w-3 mr-1" />
              )}
              Sync to Shopify
            </Button>
          </div>
        </CardContent>
      </Card>

      {syncResult && (
        <div className="text-sm px-1 text-muted-foreground">{syncResult}</div>
      )}

      {/* ── Google Shopping SEO (AI-generated, retail-only) ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            Google Shopping SEO
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Generates a Google Shopping–optimised title and description with
            Claude using this product&apos;s tags, curated keywords, and variants.
            Saving pushes to the retail Shopify store&apos;s product SEO fields,
            which Simprosys reads for the Google feed. Wholesale is not
            updated (Google Shopping is retail-only).
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleGenerateSeo} disabled={seoGenerating || seoSaving}>
              {seoGenerating ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Sparkles className="h-3 w-3 mr-1" />
              )}
              Generate with AI
            </Button>
          </div>

          {seoError && (
            <div className="text-xs text-red-600 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              {seoError}
            </div>
          )}

          {seoSaved && (
            <div className="text-xs text-green-700 flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" />
              {seoSaved}
            </div>
          )}

          {seoPreview && (
            <div className="space-y-3 pt-2 border-t">
              <div className="text-xs text-muted-foreground">
                Generated by <span className="font-mono">{seoPreview.model}</span>
                {seoPreview.warnings.length > 0 && (
                  <span className="text-amber-700 ml-2">
                    ⚠ {seoPreview.warnings.join("; ")}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Current title</Label>
                  <div className="p-2 bg-muted/30 rounded border text-xs whitespace-pre-wrap min-h-[3rem]">
                    {seoPreview.current.title || <span className="text-muted-foreground">(empty)</span>}
                  </div>
                  <Label className="text-xs text-muted-foreground">Current description</Label>
                  <div className="p-2 bg-muted/30 rounded border text-xs whitespace-pre-wrap min-h-[5rem]">
                    {seoPreview.current.description || <span className="text-muted-foreground">(empty)</span>}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs flex items-center justify-between">
                    <span>New title</span>
                    <span className="font-mono text-muted-foreground">
                      {seoPreview.generated.char_count.title} chars
                    </span>
                  </Label>
                  <Textarea
                    value={seoPreview.generated.title}
                    onChange={(e) =>
                      setSeoPreview({
                        ...seoPreview,
                        generated: {
                          ...seoPreview.generated,
                          title: e.target.value,
                          char_count: {
                            ...seoPreview.generated.char_count,
                            title: e.target.value.length,
                          },
                        },
                      })
                    }
                    rows={2}
                    className="text-xs"
                  />
                  <Label className="text-xs flex items-center justify-between">
                    <span>New description</span>
                    <span className="font-mono text-muted-foreground">
                      {seoPreview.generated.char_count.description} chars
                    </span>
                  </Label>
                  <Textarea
                    value={seoPreview.generated.description}
                    onChange={(e) =>
                      setSeoPreview({
                        ...seoPreview,
                        generated: {
                          ...seoPreview.generated,
                          description: e.target.value,
                          char_count: {
                            ...seoPreview.generated.char_count,
                            description: e.target.value.length,
                          },
                        },
                      })
                    }
                    rows={6}
                    className="text-xs"
                  />
                </div>
              </div>

              {seoPreview.generated.keywords_used.length > 0 && (
                <div className="text-xs text-muted-foreground">
                  Keywords used:{" "}
                  {seoPreview.generated.keywords_used.map((k, i) => (
                    <Badge key={i} variant="outline" className="text-[10px] mr-1">
                      {k}
                    </Badge>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    handleSaveSeoNew(
                      seoPreview.generated.title,
                      seoPreview.generated.description,
                    )
                  }
                  disabled={seoSaving}
                >
                  {seoSaving ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <Save className="h-3 w-3 mr-1" />
                  )}
                  Save & push to retail
                </Button>
                <Button size="sm" variant="outline" onClick={() => setSeoPreview(null)}>
                  Discard
                </Button>
                <Button size="sm" variant="outline" onClick={handleGenerateSeo}>
                  <RefreshCw className="h-3 w-3 mr-1" />
                  Regenerate
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Tag-curated metafield sync (separate from AI sync) ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Tags className="h-4 w-4" />
            Tag-curated metafields
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Pushes the 4 metafields the user curates via product tags
            (lens-polarization, eyewear-frame-design, target-gender,
            color-pattern) plus the custom <code>custom.frame_shape</code> field.
            Uses the Tags tab as the single source of truth — no AI.
          </p>
          <div className="flex items-center gap-2">
            <Select value={tagSyncStore} onValueChange={(v) => setTagSyncStore(v as typeof tagSyncStore)}>
              <SelectTrigger className="w-44 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="both">Both stores</SelectItem>
                <SelectItem value="dtc">Retail (DTC) only</SelectItem>
                <SelectItem value="wholesale">Wholesale only</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" onClick={handleTagSync} disabled={tagSyncing}>
              {tagSyncing ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Send className="h-3 w-3 mr-1" />
              )}
              Sync from tags
            </Button>
          </div>

          {tagSyncError && (
            <div className="text-xs text-red-600 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              {tagSyncError}
            </div>
          )}

          {tagSyncResult && (
            <div className="space-y-2 pt-1">
              {tagSyncResult.stores.map((s) => {
                const fullySuccessful = s.ok && s.skipReasons.length === 0 && s.metafieldErrors.length === 0;
                const colorClass = fullySuccessful
                  ? "text-green-700 bg-green-50 border-green-200"
                  : s.ok
                  ? "text-amber-700 bg-amber-50 border-amber-200"
                  : "text-red-700 bg-red-50 border-red-200";
                return (
                  <div key={s.store} className={`text-xs border rounded p-2 ${colorClass}`}>
                    <div className="flex items-center gap-1 font-medium">
                      {fullySuccessful ? (
                        <CheckCircle2 className="h-3 w-3" />
                      ) : (
                        <AlertCircle className="h-3 w-3" />
                      )}
                      <span className="capitalize">
                        {s.store === "dtc" ? "Retail (DTC)" : "Wholesale"}
                      </span>
                      <span className="ml-auto">
                        {s.metafieldsWritten}/{s.metafieldsAttempted} written
                      </span>
                    </div>
                    {s.resolved.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {s.resolved.map((r, i) => (
                          <li key={i} className="flex items-center gap-1">
                            <span className={r.gid || r.field === "custom.frame_shape" ? "text-green-700" : "text-amber-700"}>
                              {r.gid || r.field === "custom.frame_shape" ? "✓" : "·"}
                            </span>
                            <span className="font-mono">{r.field}</span>
                            <span>=</span>
                            <span className="font-medium">{r.handle}</span>
                            {r.source && <span className="text-muted-foreground">({r.source})</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                    {s.skipReasons.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {s.skipReasons.map((sr, i) => (
                          <li key={i}>
                            ⚠ <span className="font-mono">{sr.field}</span>: {sr.reason}
                          </li>
                        ))}
                      </ul>
                    )}
                    {s.metafieldErrors.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {s.metafieldErrors.map((e, i) => (
                          <li key={i}>✗ {e}</li>
                        ))}
                      </ul>
                    )}
                    {s.mappingWarnings.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-muted-foreground">
                        {s.mappingWarnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {parsed && (
        <>
          {/* SEO */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">SEO</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">Title</Label>
                <Input
                  value={seoTitle}
                  onChange={(e) => setSeoTitle(e.target.value)}
                  className="h-8"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Description</Label>
                <Input
                  value={seoDescription}
                  onChange={(e) => setSeoDescription(e.target.value)}
                  className="h-8"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={handleSaveAiCategorizationSeo}
                disabled={savingSeo}
              >
                <Save className="h-3 w-3 mr-1" />
                Save SEO
              </Button>
            </CardContent>
          </Card>

          {/* Category metafields */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Shopify Category Metafields</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {metafields &&
                  Object.entries(metafields).map(([key, value]) => (
                    <div key={key} className="space-y-1.5">
                      <p className="text-xs text-muted-foreground font-medium">
                        {METAFIELD_LABELS[key] || key.replace(/_/g, " ")}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {Array.isArray(value) ? (
                          value.map((v) => (
                            <Badge key={v} variant="secondary" className="text-xs">
                              {v}
                            </Badge>
                          ))
                        ) : (
                          <Badge variant="secondary" className="text-xs">
                            {String(value)}
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
