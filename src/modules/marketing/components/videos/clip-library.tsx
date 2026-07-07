"use client";

/**
 * Clip Library — the raw-material manager for the Video Remix Studio.
 *
 * Upload (batch defaults), browse the grid, refine tags per clip,
 * bulk-retag selections, and manage the category vocabulary.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RefreshCw, Trash2, Volume2, VolumeX, Zap } from "lucide-react";
import { ClipUploader, type UploaderCategory, type UploaderSku } from "./clip-uploader";

type Category = UploaderCategory & {
  description: string | null;
  is_hook: number;
  archived: number;
  ready_clips: number;
  total_clips: number;
};

type Clip = {
  id: string;
  file_name: string;
  status: string;
  category_id: string | null;
  category_slug: string | null;
  category_name: string | null;
  audio_mode: "mute" | "keep";
  boost: number;
  duration_sec: number | null;
  times_used: number;
  error: string | null;
  notes: string | null;
  posterUrl: string | null;
  previewUrl: string | null;
  products: Array<{ skuId: string; sku: string | null; colorName: string | null; productName: string | null }>;
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  ready: "default",
  uploaded: "secondary",
  normalizing: "secondary",
  failed: "destructive",
  archived: "outline",
};

export function ClipLibrary() {
  const [clips, setClips] = useState<Clip[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [skus, setSkus] = useState<UploaderSku[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterCategory, setFilterCategory] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterUntagged, setFilterUntagged] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editClip, setEditClip] = useState<Clip | null>(null);
  const [showCategories, setShowCategories] = useState(false);
  const [showUploader, setShowUploader] = useState(false);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (filterCategory) params.set("category", filterCategory);
    if (filterStatus) params.set("status", filterStatus);
    if (filterUntagged) params.set("untagged", "1");
    Promise.all([
      fetch(`/api/v1/marketing/videos/clips?${params}`).then((r) => r.json()),
      fetch("/api/v1/marketing/videos/categories").then((r) => r.json()),
    ]).then(([clipsRes, catsRes]) => {
      setClips(clipsRes.clips ?? []);
      setCategories(catsRes.categories ?? []);
      setLoading(false);
    });
  }, [filterCategory, filterStatus, filterUntagged]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    fetch("/api/v1/marketing/videos/skus")
      .then((r) => r.json())
      .then((d) => setSkus(d.skus ?? []));
  }, []);

  // Poll while anything is normalizing so statuses flip live.
  useEffect(() => {
    const pending = clips.some((c) => c.status === "uploaded" || c.status === "normalizing");
    if (!pending) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [clips, load]);

  const activeCategories = useMemo(() => categories.filter((c) => !c.archived), [categories]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const bulkPatch = async (patch: Record<string, unknown>) => {
    const res = await fetch("/api/v1/marketing/videos/clips/bulk", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clipIds: [...selected], ...patch }),
    });
    if (res.ok) {
      toast.success(`Updated ${selected.size} clips`);
      setSelected(new Set());
      load();
    } else {
      toast.error((await res.json()).error ?? "Bulk update failed");
    }
  };

  if (loading) return <div className="animate-pulse h-96 bg-muted rounded-lg" />;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setShowUploader((v) => !v)}>
          {showUploader ? "Hide uploader" : "Upload clips"}
        </Button>
        <Button variant="outline" onClick={() => setShowCategories(true)}>
          Categories
        </Button>
        <div className="flex-1" />
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          className="border rounded px-2 py-1.5 text-sm bg-background"
        >
          <option value="">All categories</option>
          {activeCategories.map((c) => (
            <option key={c.id} value={c.slug}>{c.name}</option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="border rounded px-2 py-1.5 text-sm bg-background"
        >
          <option value="">Active statuses</option>
          {["uploaded", "normalizing", "ready", "failed", "archived"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={filterUntagged} onChange={(e) => setFilterUntagged(e.target.checked)} />
          Untagged only
        </label>
        <Button variant="ghost" size="sm" onClick={load}><RefreshCw className="h-4 w-4" /></Button>
      </div>

      {showUploader && (
        <ClipUploader categories={activeCategories} skus={skus} onUploadComplete={load} />
      )}

      {/* Bulk bar */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <select
            defaultValue=""
            onChange={(e) => e.target.value && bulkPatch({ categoryId: e.target.value })}
            className="border rounded px-2 py-1 bg-background"
          >
            <option value="" disabled>Set category…</option>
            {activeCategories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <Button size="sm" variant="outline" onClick={() => bulkPatch({ audioMode: "keep" })}>Audio: keep</Button>
          <Button size="sm" variant="outline" onClick={() => bulkPatch({ audioMode: "mute" })}>Audio: mute</Button>
          <Button size="sm" variant="outline" onClick={() => bulkPatch({ boost: 1 })}>Boost</Button>
          <Button size="sm" variant="outline" onClick={() => bulkPatch({ boost: 0 })}>Unboost</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      {/* Grid */}
      {clips.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-muted-foreground">
            No clips yet. Upload your first batch — tag category, products and audio as you go.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {clips.map((clip) => (
            <div
              key={clip.id}
              className={`group relative rounded-lg border overflow-hidden cursor-pointer transition-shadow hover:shadow-md ${selected.has(clip.id) ? "ring-2 ring-primary" : ""}`}
              onClick={(e) => {
                if (e.shiftKey || selected.size > 0) toggleSelect(clip.id);
                else setEditClip(clip);
              }}
            >
              <div className="aspect-[9/16] bg-muted relative">
                {clip.posterUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={clip.posterUrl} alt={clip.file_name} className="w-full h-full object-cover" />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground p-2 text-center">
                    {clip.status === "failed" ? "normalize failed" : "processing…"}
                  </div>
                )}
                <input
                  type="checkbox"
                  checked={selected.has(clip.id)}
                  onChange={() => toggleSelect(clip.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute top-1.5 left-1.5 h-4 w-4 opacity-0 group-hover:opacity-100 checked:opacity-100"
                />
                <div className="absolute top-1.5 right-1.5 flex gap-1">
                  {clip.audio_mode === "keep" ? (
                    <span className="rounded bg-black/60 p-0.5 text-white"><Volume2 className="h-3 w-3" /></span>
                  ) : (
                    <span className="rounded bg-black/60 p-0.5 text-white/60"><VolumeX className="h-3 w-3" /></span>
                  )}
                  {clip.boost > 0 && (
                    <span className="rounded bg-amber-500/90 p-0.5 text-white"><Zap className="h-3 w-3" /></span>
                  )}
                </div>
                {clip.duration_sec != null && (
                  <span className="absolute bottom-1.5 right-1.5 rounded bg-black/60 px-1 text-[10px] text-white">
                    {clip.duration_sec.toFixed(1)}s
                  </span>
                )}
              </div>
              <div className="p-1.5 space-y-1">
                <div className="flex items-center gap-1">
                  <Badge variant={STATUS_VARIANT[clip.status] ?? "outline"} className="text-[10px] px-1">
                    {clip.status}
                  </Badge>
                  {clip.category_name ? (
                    <Badge variant="outline" className="text-[10px] px-1 truncate">{clip.category_name}</Badge>
                  ) : (
                    <Badge variant="destructive" className="text-[10px] px-1">untagged</Badge>
                  )}
                </div>
                <div className="truncate text-[11px] text-muted-foreground" title={clip.file_name}>
                  {clip.file_name}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editClip && (
        <ClipEditDialog
          clip={editClip}
          categories={activeCategories}
          skus={skus}
          onClose={() => setEditClip(null)}
          onSaved={() => {
            setEditClip(null);
            load();
          }}
        />
      )}

      {showCategories && (
        <CategoryManager
          categories={categories}
          onClose={() => setShowCategories(false)}
          onChanged={load}
        />
      )}
    </div>
  );
}

// ── Per-clip editor ──

function ClipEditDialog({
  clip,
  categories,
  skus,
  onClose,
  onSaved,
}: {
  clip: Clip;
  categories: Category[];
  skus: UploaderSku[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [categoryId, setCategoryId] = useState(clip.category_id ?? "");
  const [audioMode, setAudioMode] = useState(clip.audio_mode);
  const [boost, setBoost] = useState(clip.boost);
  const [notes, setNotes] = useState(clip.notes ?? "");
  const [skuIds, setSkuIds] = useState<string[]>(clip.products.map((p) => p.skuId));
  const [skuSearch, setSkuSearch] = useState("");
  const [saving, setSaving] = useState(false);

  const visibleSkus = useMemo(() => {
    const q = skuSearch.toLowerCase();
    return skus.filter(
      (s) =>
        !q ||
        s.sku?.toLowerCase().includes(q) ||
        s.colorName?.toLowerCase().includes(q) ||
        s.productName?.toLowerCase().includes(q),
    );
  }, [skus, skuSearch]);

  const save = async () => {
    setSaving(true);
    const res = await fetch(`/api/v1/marketing/videos/clips/${clip.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categoryId: categoryId || null, audioMode, boost, notes, skuIds }),
    });
    setSaving(false);
    if (res.ok) {
      toast.success("Clip updated");
      onSaved();
    } else {
      toast.error((await res.json()).error ?? "Update failed");
    }
  };

  const archive = async () => {
    await fetch(`/api/v1/marketing/videos/clips/${clip.id}`, { method: "DELETE" });
    toast.success("Clip archived");
    onSaved();
  };

  const renormalize = async () => {
    const res = await fetch(`/api/v1/marketing/videos/clips/${clip.id}/renormalize`, { method: "POST" });
    if (res.ok) toast.success("Re-normalization queued");
    else toast.error((await res.json()).error ?? "Failed");
    onSaved();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate">{clip.file_name}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-4">
          <div className="space-y-2">
            <div className="aspect-[9/16] bg-muted rounded overflow-hidden">
              {clip.previewUrl ? (
                <video src={clip.previewUrl} poster={clip.posterUrl ?? undefined} controls muted className="w-full h-full object-cover" />
              ) : clip.posterUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={clip.posterUrl} alt="" className="w-full h-full object-cover" />
              ) : null}
            </div>
            {clip.error && <p className="text-xs text-destructive">{clip.error}</p>}
            <p className="text-xs text-muted-foreground">Used in {clip.times_used} videos</p>
          </div>
          <div className="space-y-3 text-sm">
            <label className="block">
              <span className="text-muted-foreground">Category</span>
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="mt-1 w-full border rounded px-2 py-1.5 bg-background">
                <option value="">(untagged — excluded from videos)</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
            <div className="flex gap-3">
              <label className="block flex-1">
                <span className="text-muted-foreground">Audio</span>
                <select value={audioMode} onChange={(e) => setAudioMode(e.target.value as "mute" | "keep")} className="mt-1 w-full border rounded px-2 py-1.5 bg-background">
                  <option value="mute">Mute — trending audio will cover it</option>
                  <option value="keep">Keep — audio is worth using</option>
                </select>
              </label>
              <label className="block w-32">
                <span className="text-muted-foreground">Boost</span>
                <select value={boost} onChange={(e) => setBoost(Number(e.target.value))} className="mt-1 w-full border rounded px-2 py-1.5 bg-background">
                  <option value={0}>Normal</option>
                  <option value={1}>Boosted</option>
                  <option value={2}>Heavy</option>
                </select>
              </label>
            </div>
            <div>
              <span className="text-muted-foreground">Products in this clip ({skuIds.length})</span>
              <Input placeholder="Search SKUs…" value={skuSearch} onChange={(e) => setSkuSearch(e.target.value)} className="mt-1 mb-1 h-8" />
              <div className="max-h-36 overflow-y-auto rounded border p-1.5 space-y-0.5">
                {visibleSkus.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 px-1 hover:bg-muted rounded cursor-pointer">
                    <input
                      type="checkbox"
                      checked={skuIds.includes(s.id)}
                      onChange={() =>
                        setSkuIds((prev) => (prev.includes(s.id) ? prev.filter((x) => x !== s.id) : [...prev, s.id]))
                      }
                    />
                    <span className="truncate">
                      {s.productName ?? s.sku} {s.colorName ? `— ${s.colorName}` : ""}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <label className="block">
              <span className="text-muted-foreground">Notes</span>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1" />
            </label>
          </div>
        </div>
        <div className="flex justify-between gap-2 pt-2">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={renormalize}>
              <RefreshCw className="h-3.5 w-3.5 mr-1" /> Re-normalize
            </Button>
            <Button variant="outline" size="sm" onClick={archive}>
              <Trash2 className="h-3.5 w-3.5 mr-1" /> Archive
            </Button>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Category manager ──

function CategoryManager({
  categories,
  onClose,
  onChanged,
}: {
  categories: Category[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [newIsHook, setNewIsHook] = useState(false);

  const create = async () => {
    if (!newName.trim()) return;
    const res = await fetch("/api/v1/marketing/videos/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName, isHook: newIsHook }),
    });
    if (res.ok) {
      toast.success(`Category "${newName}" created`);
      setNewName("");
      setNewIsHook(false);
      onChanged();
    } else {
      toast.error((await res.json()).error ?? "Create failed");
    }
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    await fetch(`/api/v1/marketing/videos/categories/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    onChanged();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Clip categories</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {categories.map((c) => (
            <div key={c.id} className={`flex items-center gap-2 rounded border p-2 text-sm ${c.archived ? "opacity-50" : ""}`}>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">
                  {c.name} {c.is_hook ? <Badge variant="outline" className="ml-1 text-[10px]">hook</Badge> : null}
                </div>
                <div className="text-xs text-muted-foreground">
                  {c.slug} · {c.ready_clips} ready / {c.total_clips} clips
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => patch(c.id, { archived: !c.archived })}
              >
                {c.archived ? "Restore" : "Archive"}
              </Button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 pt-2 border-t">
          <Input
            placeholder="New category name (e.g. In Car)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
          />
          <label className="flex items-center gap-1 text-xs whitespace-nowrap">
            <input type="checkbox" checked={newIsHook} onChange={(e) => setNewIsHook(e.target.checked)} />
            can open
          </label>
          <Button onClick={create}>Add</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
