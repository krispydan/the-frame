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
  frameShapeCropUrl?: string | null;
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

  /** AI: classify frame shape across a batch of untagged clips. */
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
      toast.success(
        `Classified ${d.scanned} clip${d.scanned === 1 ? "" : "s"} — ${d.suggested} got shape suggestions${
          d.capped ? " (batch capped; run again for more)" : ""
        }`,
      );
      load();
    } else {
      toast.error(d.error ?? "Frame-shape suggestion failed");
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
          <Button
            variant="secondary"
            onClick={suggestShapesBulk}
            disabled={shaping || !aiConfigured}
            title={aiConfigured ? "AI-classify frame shape on a batch of untagged clips" : "Set ANTHROPIC_API_KEY to enable"}
          >
            <Sparkles className="h-4 w-4 mr-1" /> {shaping ? "Classifying…" : "Suggest by shape"}
          </Button>
        )}
        <Button onClick={matchFilenames} disabled={matching}>
          <Wand2 className="h-4 w-4 mr-1" /> {matching ? "Matching…" : "Match file names"}
        </Button>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-muted-foreground">
            Queue is clear — every {type === "clip" ? "clip" : "image"} has been reviewed. 🎉
          </CardContent>
        </Card>
      ) : !item ? null : (
        <>
          {/* Thumbnail strip */}
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {items.slice(0, 60).map((i) => (
              <button
                key={i.mediaId}
                onClick={() => setCurrentId(i.mediaId)}
                className={`relative h-16 w-11 shrink-0 overflow-hidden rounded border ${i.mediaId === currentId ? "ring-2 ring-primary" : ""}`}
                title={i.fileName}
              >
                {i.mediaUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={i.mediaUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center bg-muted text-[10px]">?</span>
                )}
                {i.matchStatus === "suggested" && (
                  <span className="absolute bottom-0.5 right-0.5 h-2 w-2 rounded-full bg-blue-500" />
                )}
              </button>
            ))}
          </div>

          {/* Review panel */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 min-w-0">
            {/* Media */}
            <div className="space-y-2 min-w-0">
              <div className="aspect-[9/16] max-w-[280px] mx-auto bg-muted rounded-lg overflow-hidden">
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
              <p className="text-center text-xs text-muted-foreground truncate">{item.fileName}</p>
              {item.currentProducts.length > 0 && (
                <p className="text-center text-xs text-muted-foreground">
                  currently tagged: {item.currentProducts.map((p) => p.name).join(", ")}
                </p>
              )}
            </div>

            {/* Catalog picker */}
            <div className="space-y-2 min-w-0">
              {/* Filename match (pre-ticked) */}
              {fileMatches.length > 0 && (
                <div className="space-y-1.5">
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
                        <ProductThumb url={c.imageUrl} className="h-16 w-24" />
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
                <div className="space-y-2 rounded-lg border p-2.5">
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
                  {item.frameShapeCropUrl && (
                    <div className="flex items-center gap-2 rounded-md bg-muted/40 p-1.5">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={item.frameShapeCropUrl}
                        alt="AI crop"
                        className="h-24 w-auto rounded border bg-white object-contain"
                      />
                      <span className="text-xs text-muted-foreground">
                        This is the exact cropped frame sent to the AI. If the glasses aren’t clearly
                        framed here, that’s why the match is off — tell me and I’ll adjust the crop.
                      </span>
                    </div>
                  )}
                  {shapeMatches.length > 0 ? (
                    <div className="grid max-h-[460px] grid-cols-2 gap-2 overflow-y-auto">
                      {shapeMatches.map((c, i) => {
                        const on = selected.includes(c.productId);
                        return (
                          <button
                            key={c.productId}
                            onClick={() => toggle(c.productId)}
                            className={`relative flex flex-col items-center gap-1 rounded-lg border p-2 text-center ${on ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted"}`}
                            title={c.productName}
                          >
                            <span className="absolute top-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                              #{i + 1} · {c.confidence}%
                            </span>
                            {on && (
                              <span className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                                <Check className="h-3.5 w-3.5" />
                              </span>
                            )}
                            <ProductThumb url={c.imageUrl} className="h-28 w-full border-0" />
                            <span className="w-full truncate text-sm font-medium">{c.productName}</span>
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

              {/* Full catalog */}
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">Catalog</p>
                  <Input
                    placeholder="Filter products…"
                    value={catalogSearch}
                    onChange={(e) => setCatalogSearch(e.target.value)}
                    className="h-8 flex-1"
                  />
                </div>
                <div className="mt-1.5 grid max-h-[420px] grid-cols-2 gap-1.5 overflow-y-auto rounded-lg border p-1.5 sm:grid-cols-3">
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
                        <ProductThumb url={p.imageUrl} className="h-14 w-full border-0" />
                        <span className="w-full truncate text-xs">{p.name ?? "Unnamed"}</span>
                      </button>
                    );
                  })}
                  {catalog.length === 0 && (
                    <span className="col-span-full p-3 text-center text-sm text-muted-foreground">No products match “{catalogSearch}”</span>
                  )}
                </div>
              </div>

              {/* Video type (category) — clips only */}
              {type === "clip" && (
                <label className="block">
                  <span className="text-sm font-medium">Video type</span>
                  <select
                    value={categoryId}
                    onChange={(e) => setCategoryId(e.target.value)}
                    className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
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

              {/* Notes */}
              <label className="block">
                <span className="text-sm font-medium">Notes</span>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="What's happening in this video / shot (optional) — saved with your decision"
                  rows={2}
                  className="mt-1 w-full resize-y rounded-md border bg-background px-2.5 py-1.5 text-sm"
                />
              </label>

              {/* Selection + actions */}
              {selected.length > 0 && (
                <div className="flex flex-wrap gap-1">
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
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                <Button onClick={() => save(false)} disabled={saving || selected.length === 0}>
                  <Check className="h-4 w-4 mr-1" /> Save {selected.length > 1 ? `${selected.length} products` : "product"}
                </Button>
                <Button variant="outline" onClick={() => save(true)} disabled={saving}>
                  No product visible
                </Button>
                <Button variant="ghost" onClick={skip}>Skip</Button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
