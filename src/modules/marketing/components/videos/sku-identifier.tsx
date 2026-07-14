"use client";

/**
 * SKU Identifier — AI-assisted product tagging review queue.
 *
 * Pick a media type (video clips / catalog images), run AI identification
 * against the catalog reference sheets, then review: media on the left,
 * candidate products with confidence on the right. Click the right
 * product(s) and save — tags are written back to the media. Low-confidence
 * items show every option the model considered; a manual product search
 * covers the case where the model missed entirely.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Check, RefreshCw, Sparkles, X } from "lucide-react";

type Candidate = {
  productId: string;
  productName: string;
  sku: string;
  colorName: string | null;
  confidence: number;
  via?: "filename" | "vision" | "both";
  imageUrl?: string | null;
};

type Item = {
  mediaType: "clip" | "image";
  mediaId: string;
  fileName: string;
  mediaUrl: string | null;
  previewUrl: string | null;
  durationSec: number | null;
  currentProducts: Array<{ id: string; name: string | null; imageUrl?: string | null }>;
  currentSku?: string | null;
  matchStatus: string | null;
  candidates: Candidate[];
  confirmedProductIds: string[];
  matchError: string | null;
};

type Product = { id: string; name: string | null; skuIds: string[]; imageUrl?: string | null };

/** Small square product thumbnail used across the candidate / picker rows. */
function ProductThumb({ url, className = "" }: { url?: string | null; className?: string }) {
  return (
    <span className={`flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded bg-muted ${className}`}>
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
  const [aiConfigured, setAiConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  // Track the selected item by ID, not index — the list re-sorts as items
  // become "suggested", and an index would jump to a different clip.
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [manualSearch, setManualSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [identifying, setIdentifying] = useState(false);
  // Only auto-apply the model's top pick to the selection once per item.
  const autoSelectedFor = useRef<string | null>(null);
  // Media we've queued this session — shown as "processing" until a real
  // status comes back (the server has no match row while a job is mid-run).
  const inFlight = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    const res = await fetch(`${API}?type=${type}&filter=${filter}`);
    const d = await res.json();
    const mapped: Item[] = (d.items ?? []).map((i: Item) => {
      const real = i.matchStatus;
      if (real && real !== "pending") inFlight.current.delete(i.mediaId);
      return { ...i, matchStatus: real ?? (inFlight.current.has(i.mediaId) ? "pending" : null) };
    });
    setItems(mapped);
    setProducts(d.products ?? []);
    setAiConfigured(Boolean(d.aiConfigured));
    setLoading(false);
  }, [type, filter]);

  useEffect(() => {
    setLoading(true);
    setCurrentId(null);
    autoSelectedFor.current = null;
    load();
  }, [load]);

  // Poll while identification jobs are outstanding so suggestions stream in.
  const hasPending = items.some((i) => i.matchStatus === "pending" || (identifying && i.matchStatus === null));
  useEffect(() => {
    if (!hasPending) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [hasPending, load]);

  // Keep a valid selection as the list changes/re-sorts.
  useEffect(() => {
    if (items.length === 0) return;
    if (!currentId || !items.some((i) => i.mediaId === currentId)) {
      setCurrentId(items[0].mediaId);
    }
  }, [items, currentId]);

  const currentIndex = Math.max(0, items.findIndex((i) => i.mediaId === currentId));
  const item = items.find((i) => i.mediaId === currentId) ?? items[currentIndex] ?? null;

  // Pre-select when arriving on an item: existing tags first (so a tagged
  // item shows its products checked and editable), else the model's
  // confident top pick.
  useEffect(() => {
    if (!item || autoSelectedFor.current === item.mediaId) return;
    autoSelectedFor.current = item.mediaId;
    const current = item.currentProducts.map((p) => p.id).filter(Boolean);
    if (current.length > 0) {
      setSelected(current);
    } else {
      const confident = item.candidates.filter((c) => c.confidence >= 75).map((c) => c.productId);
      setSelected(confident.length > 0 ? [confident[0]] : []);
    }
    setManualSearch("");
  }, [item]);

  const identifyAll = async (force = false) => {
    setIdentifying(true);
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaType: type, all: true, force }),
    });
    const d = await res.json();
    if (res.ok) {
      // Optimistically mark the queued items as processing so the panel
      // shows movement immediately (the poll flips them as jobs finish).
      if (d.enqueued > 0) {
        setItems((prev) =>
          prev.map((i) => {
            if (i.matchStatus === null || (force && i.matchStatus !== "confirmed")) {
              inFlight.current.add(i.mediaId);
              return { ...i, matchStatus: "pending" };
            }
            return i;
          }),
        );
      }
      toast.success(d.enqueued > 0 ? `AI identifying ${d.enqueued} item${d.enqueued === 1 ? "" : "s"} in the background` : "Nothing new to identify");
    } else {
      toast.error(d.error ?? "Could not start identification");
    }
  };

  const identifyOne = async () => {
    if (!item) return;
    await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaType: type, mediaIds: [item.mediaId], force: true }),
    });
    inFlight.current.add(item.mediaId);
    setItems((prev) => prev.map((i) => (i.mediaId === item.mediaId ? { ...i, matchStatus: "pending" } : i)));
    setIdentifying(true);
    toast.success("Re-running AI on this item");
  };

  // Drop the current item and move to the next one (by id, so the list can
  // re-sort freely without losing our place).
  const advance = () => {
    const idx = items.findIndex((i) => i.mediaId === currentId);
    const next = items[idx + 1] ?? items[idx - 1] ?? null;
    setItems((prev) => prev.filter((i) => i.mediaId !== currentId));
    setCurrentId(next ? next.mediaId : null);
    autoSelectedFor.current = null;
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
          ? { mediaType: type, mediaId: item.mediaId, noProduct: true }
          : { mediaType: type, mediaId: item.mediaId, productIds: selected },
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

  const manualMatches = useMemo(() => {
    const q = manualSearch.trim().toLowerCase();
    if (!q) return [];
    return products.filter((p) => p.name?.toLowerCase().includes(q)).slice(0, 8);
  }, [manualSearch, products]);

  const suggested = items.filter((i) => i.matchStatus === "suggested").length;
  const unidentified = items.filter((i) => i.matchStatus === null || i.matchStatus === "failed").length;

  if (loading) return <div className="animate-pulse h-96 bg-muted rounded-lg" />;

  return (
    <div className="space-y-4">
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
        <span className="text-sm text-muted-foreground">
          {items.length} shown · {suggested} AI-suggested · {unidentified} not yet identified
        </span>
        <div className="flex-1" />
        <Button onClick={() => identifyAll(false)} disabled={!aiConfigured}>
          <Sparkles className="h-4 w-4 mr-1" /> Identify all with AI
        </Button>
      </div>

      {!aiConfigured && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
          ANTHROPIC_API_KEY isn&apos;t set in this environment — AI runs on the server where it is configured.
        </div>
      )}

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
                <span
                  className={`absolute bottom-0.5 right-0.5 h-2 w-2 rounded-full ${
                    i.matchStatus === "suggested" ? "bg-blue-500" : i.matchStatus === "pending" ? "bg-amber-400 animate-pulse" : i.matchStatus === "failed" ? "bg-red-500" : "bg-gray-300"
                  }`}
                />
              </button>
            ))}
          </div>

          {/* Review panel */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Media */}
            <div className="space-y-2">
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

            {/* Candidates */}
            <div className="space-y-2">
              {item.matchStatus === "pending" && (
                <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5 text-sm">
                  <RefreshCw className="h-4 w-4 animate-spin text-primary" />
                  <span>
                    <span className="font-medium">Analyzing…</span>
                    <span className="block text-xs text-muted-foreground">
                      Checking the file name, then sampling video frames against the catalog.
                    </span>
                  </span>
                </div>
              )}
              {item.matchStatus === "failed" && item.matchError && (
                <div className="rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  AI failed: {item.matchError}
                </div>
              )}
              {item.matchStatus === null && (
                <div className="text-sm text-muted-foreground">
                  Not identified yet — hit <b>Identify all with AI</b> above, or tag manually below.
                </div>
              )}

              {item.candidates.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">AI matches</p>
                  {item.candidates.map((c) => {
                    const on = selected.includes(c.productId);
                    return (
                      <button
                        key={c.productId}
                        onClick={() => toggle(c.productId)}
                        className={`flex w-full items-center gap-3 rounded-lg border p-2.5 text-left text-sm transition-colors ${on ? "border-primary bg-primary/5" : "hover:bg-muted"}`}
                      >
                        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${on ? "bg-primary border-primary text-primary-foreground" : ""}`}>
                          {on && <Check className="h-3.5 w-3.5" />}
                        </span>
                        <ProductThumb url={c.imageUrl} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{c.productName}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {c.via === "filename"
                              ? "📄 matched from the file name"
                              : c.via === "both"
                                ? `looks like ${c.sku} · confirmed by file name`
                                : `looks like ${c.sku}${c.colorName ? ` (${c.colorName})` : ""}`}
                          </span>
                        </span>
                        <span className="w-24 shrink-0">
                          <span className="block text-right text-xs font-semibold">{c.confidence}%</span>
                          <span className="mt-0.5 block h-1.5 w-full rounded bg-muted">
                            <span
                              className={`block h-full rounded ${c.confidence >= 75 ? "bg-emerald-500" : c.confidence >= 45 ? "bg-amber-500" : "bg-red-400"}`}
                              style={{ width: `${c.confidence}%` }}
                            />
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Manual fallback */}
              <div className="pt-1">
                <p className="text-sm font-medium">Not in the list? Search the catalog</p>
                <Input
                  placeholder="Search products…"
                  value={manualSearch}
                  onChange={(e) => setManualSearch(e.target.value)}
                  className="mt-1 h-8"
                />
                {manualMatches.length > 0 && (
                  <div className="mt-1 space-y-0.5 rounded border p-1.5">
                    {manualMatches.map((p) => {
                      const on = selected.includes(p.id);
                      return (
                        <button
                          key={p.id}
                          onClick={() => toggle(p.id)}
                          className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${on ? "bg-primary/10" : "hover:bg-muted"}`}
                        >
                          <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? "bg-primary border-primary text-primary-foreground" : ""}`}>
                            {on && <Check className="h-3 w-3" />}
                          </span>
                          <ProductThumb url={p.imageUrl} className="h-8 w-8" />
                          <span className="truncate">{p.name ?? "Unnamed product"}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Selection summary + actions */}
              {selected.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
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
              <div className="flex flex-wrap gap-2 pt-2">
                <Button onClick={() => save(false)} disabled={saving || selected.length === 0}>
                  <Check className="h-4 w-4 mr-1" /> Save {selected.length > 1 ? `${selected.length} products` : "product"}
                </Button>
                <Button variant="outline" onClick={() => save(true)} disabled={saving}>
                  No product visible
                </Button>
                <Button variant="ghost" onClick={advance}>Skip</Button>
                <div className="flex-1" />
                <Button variant="outline" size="sm" onClick={identifyOne} disabled={!aiConfigured}>
                  <RefreshCw className="h-3.5 w-3.5 mr-1" /> Re-run AI
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
