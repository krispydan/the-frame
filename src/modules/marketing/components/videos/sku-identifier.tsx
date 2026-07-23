"use client";

/**
 * SKU Identifier — filename matching + manual review against the catalog.
 *
 * Media on the left; the FULL product catalog (with photos) on the right.
 * When the filename names a product (shoot naming convention) it's
 * matched automatically — "Match file names" bulk-applies those. Anything
 * else gets tagged by hand: find the product in the catalog panel, click
 * it, save. Works for video clips and product/lifestyle photos alike.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Check, FileText, Glasses, Sparkles, Wand2, X } from "lucide-react";

type Candidate = {
  productId: string;
  productName: string;
  sku: string;
  colorName: string | null;
  confidence: number;
  via?: "filename" | "frameshape";
  shape?: string;
  imageUrl?: string | null;
};

type FrameShape = { shape: string; confidence: number };

type Item = {
  mediaType: "clip" | "image";
  mediaId: string;
  fileName: string;
  mediaUrl: string | null;
  previewUrl: string | null;
  durationSec: number | null;
  currentProducts: Array<{ id: string; name: string | null; imageUrl?: string | null }>;
  currentSku?: string | null;
  notes: string | null;
  categoryId?: string | null;
  matchStatus: string | null;
  candidates: Candidate[];
  frameShapes?: FrameShape[];
  frameShapeCropUrls?: string[];
  confirmedProductIds: string[];
  matchError: string | null;
};

type Product = { id: string; name: string | null; skuIds: string[]; imageUrl?: string | null };
type Category = { id: string; name: string; slug: string };

/** Product photo tile used across the pickers. */
function ProductThumb({ url, className = "h-11 w-11" }: { url?: string | null; className?: string }) {
  return (
    <span className={`flex shrink-0 items-center justify-center overflow-hidden rounded bg-white border ${className}`}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="h-full w-full object-contain" />
      ) : (
        <span className="text-[10px] text-muted-foreground">no img</span>
      )}
    </span>
  );
}

const API = "/api/v1/marketing/media-match";

export function SkuIdentifier() {
  const [type, setType] = useState<"clip" | "image">("clip");
  const [filter, setFilter] = useState<"queue" | "all">("queue");
  const [items, setItems] = useState<Item[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  // Track the selected item by ID, not index — the list can reorder.
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [categoryId, setCategoryId] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [matching, setMatching] = useState(false);
  const [shaping, setShaping] = useState(false);
  // The labelled product reference fed to the AI (for inspection).
  const [sheet, setSheet] = useState<{
    productCount: number;
    items: Array<{ index: number; label: string; imageDataUrl: string }>;
  } | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetLoading, setSheetLoading] = useState(false);
  // Only auto-apply pre-selection once per item.
  const autoSelectedFor = useRef<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`${API}?type=${type}&filter=${filter}`);
    const d = await res.json();
    setItems(d.items ?? []);
    setProducts(d.products ?? []);
    setCategories(d.categories ?? []);
    setAiConfigured(Boolean(d.aiConfigured));
    setLoading(false);
  }, [type, filter]);

  useEffect(() => {
    setLoading(true);
    setCurrentId(null);
    autoSelectedFor.current = null;
    load();
  }, [load]);

  // Keep a valid selection as the list changes.
  useEffect(() => {
    if (items.length === 0) return;
    if (!currentId || !items.some((i) => i.mediaId === currentId)) {
      setCurrentId(items[0].mediaId);
    }
  }, [items, currentId]);

  const item = items.find((i) => i.mediaId === currentId) ?? null;

  // Pre-select on arrival: existing tags (editable), else the filename match.
  useEffect(() => {
    if (!item || autoSelectedFor.current === item.mediaId) return;
    autoSelectedFor.current = item.mediaId;
    const current = item.currentProducts.map((p) => p.id).filter(Boolean);
    if (current.length > 0) {
      setSelected(current);
    } else {
      const fromFile = item.candidates.filter((c) => c.via === "filename").map((c) => c.productId);
      setSelected(fromFile.slice(0, 1));
    }
    setNotes(item.notes ?? "");
    setCategoryId(item.categoryId ?? "");
    setCatalogSearch("");
  }, [item]);

  /** Bulk: apply strong filename matches across every untagged item. */
  const matchFilenames = async () => {
    setMatching(true);
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaType: type, all: true, apply: true }),
    });
    const d = await res.json();
    setMatching(false);
    if (res.ok) {
      toast.success(
        d.applied > 0
          ? `Tagged ${d.applied} from file names${d.suggested ? `, ${d.suggested} suggested` : ""} (${d.scanned} scanned)`
          : `No product names found in ${d.scanned} file name${d.scanned === 1 ? "" : "s"} — tag them manually below`,
      );
      load();
    } else {
      toast.error(d.error ?? "Matching failed");
    }
  };

  /** AI: classify the frame shape for one clip and pre-load matching
   *  products as suggestions. Reloads in place so the panel updates. */
  const suggestShapeForCurrent = async () => {
    if (!item) return;
    setShaping(true);
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaType: "clip", method: "frameshape", mediaIds: [item.mediaId] }),
    });
    const d = await res.json();
    setShaping(false);
    if (res.ok) {
      await load();
      toast[d.suggested > 0 ? "success" : "message"](
        d.suggested > 0 ? "Frame shape identified — suggestions loaded below" : "No clear frame detected in this clip",
      );
    } else {
      toast.error(d.error ?? "Frame-shape suggestion failed");
    }
  };

  /** AI: run identification over EVERY untagged clip as a background job. */
  const suggestShapesBulk = async () => {
    setShaping(true);
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaType: "clip", method: "frameshape", all: true }),
    });
    const d = await res.json();
    setShaping(false);
    if (res.ok) {
      if (d.queued) {
        toast.success(
          `Identifying ${d.total} untagged clip${d.total === 1 ? "" : "s"} in the background — products AND video types. ` +
            `Refresh in a few minutes to review.`,
          { duration: 8000 },
        );
      } else {
        toast.message(d.message ?? "Nothing to classify");
      }
    } else {
      toast.error(d.error ?? "Frame-shape suggestion failed");
    }
  };

  /** Show the exact numbered catalog sheet the AI matches against. */
  const toggleSheet = async () => {
    const next = !sheetOpen;
    setSheetOpen(next);
    if (next && !sheet) {
      setSheetLoading(true);
      try {
        const res = await fetch(`${API}/catalog-sheet`);
        const d = await res.json();
        if (res.ok) setSheet({ items: d.items ?? [], productCount: d.productCount ?? 0 });
        else toast.error(d.error ?? "Could not load the catalog sheet");
      } catch {
        toast.error("Could not load the catalog sheet");
      }
      setSheetLoading(false);
    }
  };

  const advance = () => {
    const idx = items.findIndex((i) => i.mediaId === currentId);
    const next = items[idx + 1] ?? items[idx - 1] ?? null;
    setItems((prev) => prev.filter((i) => i.mediaId !== currentId));
    setCurrentId(next ? next.mediaId : null);
    autoSelectedFor.current = null;
  };

  /** Skip without deciding — but persist an edited note/category so it isn't lost. */
  const skip = async () => {
    const noteChanged = item && notes !== (item.notes ?? "");
    const catChanged = item && type === "clip" && categoryId !== (item.categoryId ?? "");
    if (item && (noteChanged || catChanged)) {
      await fetch(API, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaType: type, mediaId: item.mediaId, notes, categoryId }),
      }).catch(() => {});
    }
    advance();
  };

  const save = async (noProduct = false) => {
    if (!item) return;
    if (!noProduct && selected.length === 0) {
      toast.error("Pick at least one product (or use ‘No product visible’)");
      return;
    }
    setSaving(true);
    const res = await fetch(API, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        noProduct
          ? { mediaType: type, mediaId: item.mediaId, noProduct: true, notes, categoryId }
          : { mediaType: type, mediaId: item.mediaId, productIds: selected, notes, categoryId },
      ),
    });
    setSaving(false);
    if (res.ok) {
      toast.success(noProduct ? "Marked: no product visible" : "Products saved");
      advance();
    } else {
      toast.error((await res.json()).error ?? "Save failed");
    }
  };

  const toggle = (productId: string) =>
    setSelected((prev) => (prev.includes(productId) ? prev.filter((p) => p !== productId) : [...prev, productId]));

  // Full catalog, filtered by search, selected products floated to the top.
  const catalog = useMemo(() => {
    const q = catalogSearch.trim().toLowerCase();
    const list = q ? products.filter((p) => p.name?.toLowerCase().includes(q)) : products;
    return [...list].sort((a, b) => {
      const sa = selected.includes(a.id) ? 0 : 1;
      const sb = selected.includes(b.id) ? 0 : 1;
      return sa - sb || (a.name ?? "").localeCompare(b.name ?? "");
    });
  }, [products, catalogSearch, selected]);

  const fileMatches = item?.candidates.filter((c) => c.via === "filename") ?? [];
  const shapeMatches = item?.candidates.filter((c) => c.via === "frameshape") ?? [];
  const detectedShapes = item?.frameShapes ?? [];

  if (loading) return <div className="animate-pulse h-96 bg-muted rounded-lg" />;

  return (
    <div className="space-y-4 min-w-0">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border overflow-hidden">
          {(["clip", "image"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`px-3 py-1.5 text-sm ${type === t ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"}`}
            >
              {t === "clip" ? "Videos" : "Images"}
            </button>
          ))}
        </div>
        <div className="flex rounded-md border overflow-hidden">
          {(["queue", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-sm ${filter === f ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"}`}
            >
              {f === "queue" ? "Untagged only" : "All"}
            </button>
          ))}
        </div>
        <span className="text-sm text-muted-foreground">{items.length} shown</span>
        <div className="flex-1" />
        {type === "clip" && (
          <Button variant="ghost" onClick={toggleSheet} title="See the catalog images fed to the AI">
            <FileText className="h-4 w-4 mr-1" /> {sheetOpen ? "Hide AI catalog" : "View AI catalog"}
          </Button>
        )}
        {type === "clip" && (
          <Button
            variant="secondary"
            onClick={suggestShapesBulk}
            disabled={shaping || !aiConfigured}
            title={
              aiConfigured
                ? "AI-identify every untagged clip in the background: ranked product suggestions + video type"
                : "Set ANTHROPIC_API_KEY to enable"
            }
          >
            <Sparkles className="h-4 w-4 mr-1" /> {shaping ? "Queuing…" : "Identify all (AI)"}
          </Button>
        )}
        <Button onClick={matchFilenames} disabled={matching}>
          <Wand2 className="h-4 w-4 mr-1" /> {matching ? "Matching…" : "Match file names"}
        </Button>
      </div>

      {/* AI catalog viewer — the exact numbered sheet fed to the model */}
      {sheetOpen && (
        <Card>
          <CardContent className="space-y-2 p-3">
            <p className="text-sm text-muted-foreground">
              {sheetLoading
                ? "Building the catalog reference…"
                : sheet
                  ? `This is exactly what the AI matches against — ${sheet.productCount} products, each sent as its own image with the text label shown. It judges frame shape only (told to ignore colour).`
                  : "No catalog reference available."}
            </p>
            {sheet && (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
                {sheet.items.map((it) => (
                  <div key={it.index} className="rounded border p-1.5 text-center">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={it.imageDataUrl} alt={it.label} className="w-full rounded bg-white object-contain" />
                    <span className="mt-1 block truncate text-[11px] text-muted-foreground" title={it.label}>
                      {it.label}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {items.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-muted-foreground">
            Queue is clear — every {type === "clip" ? "clip" : "image"} has been reviewed. 🎉
          </CardContent>
        </Card>
      ) : !item ? null : (
        <>
          {/* Thumbnail strip — compact, single row */}
          <div className="flex gap-1 overflow-x-auto pb-0.5">
            {items.slice(0, 60).map((i) => (
              <button
                key={i.mediaId}
                onClick={() => setCurrentId(i.mediaId)}
                className={`relative h-11 w-8 shrink-0 overflow-hidden rounded border ${i.mediaId === currentId ? "ring-2 ring-primary" : ""}`}
                title={i.fileName}
              >
                {i.mediaUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={i.mediaUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center bg-muted text-[10px]">?</span>
                )}
                {i.matchStatus === "suggested" && (
                  <span className="absolute bottom-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-blue-500" />
                )}
              </button>
            ))}
          </div>

          {/* Review panel — sized to fit one screen on desktop; only the
              catalog list scrolls, so the save actions stay visible. */}
          <div className="grid grid-cols-1 lg:grid-cols-[230px_minmax(0,1fr)] gap-3 min-w-0">
            {/* Media */}
            <div className="space-y-1 min-w-0">
              <div className="aspect-[9/16] max-w-[230px] mx-auto lg:mx-0 bg-muted rounded-lg overflow-hidden">
                {item.previewUrl ? (
                  <video
                    key={item.mediaId}
                    src={item.previewUrl}
                    poster={item.mediaUrl ?? undefined}
                    controls
                    muted
                    playsInline
                    className="w-full h-full object-cover"
                  />
                ) : item.mediaUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.mediaUrl} alt={item.fileName} className="w-full h-full object-contain bg-white" />
                ) : null}
              </div>
              <p className="text-center lg:text-left text-xs text-muted-foreground truncate">{item.fileName}</p>
              {item.currentProducts.length > 0 && (
                <p className="text-center lg:text-left text-xs text-muted-foreground truncate">
                  tagged: {item.currentProducts.map((p) => p.name).join(", ")}
                </p>
              )}
            </div>

            {/* Catalog picker — fixed-height column on desktop (a definite
                height lets flexbox actually shrink the catalog list); only
                the catalog scrolls inside, so actions stay visible. */}
            <div className="flex flex-col gap-2 min-w-0 lg:h-[calc(100vh-15rem)] lg:min-h-[480px]">
              {/* Filename match (pre-ticked) */}
              {fileMatches.length > 0 && (
                <div className="shrink-0 space-y-1.5">
                  {fileMatches.map((c) => {
                    const on = selected.includes(c.productId);
                    return (
                      <button
                        key={c.productId}
                        onClick={() => toggle(c.productId)}
                        className={`flex w-full items-center gap-3 rounded-lg border p-2.5 text-left text-sm ${on ? "border-primary bg-primary/5" : "hover:bg-muted"}`}
                      >
                        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${on ? "bg-primary border-primary text-primary-foreground" : ""}`}>
                          {on && <Check className="h-3.5 w-3.5" />}
                        </span>
                        <ProductThumb url={c.imageUrl} className="h-12 w-16" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{c.productName}</span>
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <FileText className="h-3 w-3" /> matched from the file name
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Frame-shape suggestions (AI, clips only) */}
              {type === "clip" && (
                <div className="shrink-0 space-y-2 rounded-lg border p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      <Glasses className="h-4 w-4" /> Frame shape
                      {detectedShapes.map((s) => (
                        <Badge key={s.shape} variant="secondary" className="capitalize">
                          {s.shape} · {s.confidence}%
                        </Badge>
                      ))}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={suggestShapeForCurrent}
                      disabled={shaping || !aiConfigured}
                      title={aiConfigured ? "Classify this clip's frame shape" : "Set ANTHROPIC_API_KEY to enable"}
                    >
                      <Sparkles className="h-3.5 w-3.5 mr-1" />
                      {shaping ? "…" : shapeMatches.length > 0 ? "Re-run" : "Suggest"}
                    </Button>
                  </div>
                  {(item.frameShapeCropUrls?.length ?? 0) > 0 && (
                    <div className="flex items-center gap-1.5 overflow-x-auto rounded-md bg-muted/40 p-1" title="The exact crops sent to the AI (sampled across the clip)">
                      {item.frameShapeCropUrls!.map((u, i) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={i} src={u} alt={`AI crop ${i + 1}`} className="h-14 w-auto rounded border bg-white object-contain" />
                      ))}
                      <span className="shrink-0 px-1 text-[10px] text-muted-foreground">AI inputs</span>
                    </div>
                  )}
                  {shapeMatches.length > 0 ? (
                    <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
                      {shapeMatches.map((c) => {
                        const on = selected.includes(c.productId);
                        return (
                          <button
                            key={c.productId}
                            onClick={() => toggle(c.productId)}
                            className={`relative flex flex-col items-center gap-1 rounded-lg border p-2 text-center ${on ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted"}`}
                            title={c.productName}
                          >
                            <span className="absolute top-0.5 left-0.5 z-10 rounded bg-black/70 px-1 py-0.5 text-[10px] font-semibold text-white">
                              {c.confidence}%
                            </span>
                            {on && (
                              <span className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                                <Check className="h-3.5 w-3.5" />
                              </span>
                            )}
                            <ProductThumb url={c.imageUrl} className="h-16 w-full border-0" />
                            <span className="w-full truncate text-xs font-medium">{c.productName}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {aiConfigured
                        ? "Classify the glasses shape to pre-load the matching products from the catalog."
                        : "Set ANTHROPIC_API_KEY to enable AI shape suggestions."}
                    </p>
                  )}
                </div>
              )}

              {/* Full catalog — fills the remaining height, scrolls inside */}
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">Catalog</p>
                  <Input
                    placeholder="Filter products…"
                    value={catalogSearch}
                    onChange={(e) => setCatalogSearch(e.target.value)}
                    className="h-8 flex-1"
                  />
                </div>
                <div className="mt-1.5 grid min-h-0 flex-1 grid-cols-3 gap-1.5 overflow-y-auto rounded-lg border p-1.5 content-start max-h-[300px] lg:max-h-none sm:grid-cols-4">
                  {catalog.map((p) => {
                    const on = selected.includes(p.id);
                    return (
                      <button
                        key={p.id}
                        onClick={() => toggle(p.id)}
                        className={`relative flex flex-col items-center gap-1 rounded-lg border p-2 text-center ${on ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted"}`}
                        title={p.name ?? undefined}
                      >
                        {on && (
                          <span className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                            <Check className="h-3 w-3" />
                          </span>
                        )}
                        <ProductThumb url={p.imageUrl} className="h-12 w-full border-0" />
                        <span className="w-full truncate text-xs">{p.name ?? "Unnamed"}</span>
                      </button>
                    );
                  })}
                  {catalog.length === 0 && (
                    <span className="col-span-full p-3 text-center text-sm text-muted-foreground">No products match “{catalogSearch}”</span>
                  )}
                </div>
              </div>

              {/* Video type + notes — one compact row */}
              <div className={`shrink-0 grid gap-2 ${type === "clip" ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}>
                {type === "clip" && (
                  <label className="block">
                    <span className="text-xs font-medium">Video type</span>
                    <select
                      value={categoryId}
                      onChange={(e) => setCategoryId(e.target.value)}
                      className="mt-0.5 h-9 w-full rounded-md border bg-background px-2.5 text-sm"
                    >
                      <option value="">— Uncategorized —</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="block">
                  <span className="text-xs font-medium">Notes</span>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="What's in this video (optional)"
                    rows={1}
                    className="mt-0.5 h-9 w-full resize-y rounded-md border bg-background px-2.5 py-1.5 text-sm"
                  />
                </label>
              </div>

              {/* Selection + actions */}
              <div className="shrink-0 flex flex-wrap items-center gap-2">
                <Button onClick={() => save(false)} disabled={saving || selected.length === 0}>
                  <Check className="h-4 w-4 mr-1" /> Save {selected.length > 1 ? `${selected.length} products` : "product"}
                </Button>
                <Button variant="outline" onClick={() => save(true)} disabled={saving}>
                  No product visible
                </Button>
                <Button variant="ghost" onClick={skip}>Skip</Button>
                {selected.map((id) => {
                  const p = products.find((x) => x.id === id);
                  return (
                    <Badge key={id} variant="secondary" className="gap-1">
                      {p?.name ?? id}
                      <button onClick={() => toggle(id)}><X className="h-3 w-3" /></button>
                    </Badge>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
