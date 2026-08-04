"use client";

/**
 * Watch a single clip.
 *
 * Editors show clips as poster thumbnails, which is fine for arranging a
 * sequence but useless for deciding whether a shot is any good. Clicking
 * a thumbnail opens this: the clip actually playing, with the context you
 * need to judge it (shot type, length, whether it shows the product) and
 * — where relevant — the action you'd want next (add it, remove it).
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";

export interface PreviewClip {
  id: string;
  fileName?: string;
  durationSec?: number | null;
  categoryName?: string | null;
  categorySlug?: string | null;
  isProductShot?: boolean;
  posterUrl?: string | null;
  previewUrl?: string | null;
}

export function ClipPreviewDialog({
  clip,
  onClose,
  onAdd,
  onRemove,
  onEdited,
}: {
  clip: PreviewClip;
  onClose: () => void;
  /** Shown when the clip isn't in the sequence yet. */
  onAdd?: () => void;
  /** Shown when it is. */
  onRemove?: () => void;
  /** Called after tags are saved, so the caller can refresh. */
  onEdited?: () => void;
}) {
  // Tag editing lives here rather than on each page: this dialog is the
  // shared "look at this clip" surface, so putting the editor in it means
  // every place that shows a clip can fix its tags. Previously a wrong
  // product tag could only be corrected from the clip library.
  const [editing, setEditing] = useState(false);
  const meta = [
    clip.categoryName ?? clip.categorySlug,
    clip.durationSec != null ? `${clip.durationSec.toFixed(1)}s` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="truncate pr-8 text-sm">{clip.fileName ?? "Clip"}</DialogTitle>
        </DialogHeader>

        {clip.previewUrl ? (
          // Autoplay + loop: you're here to judge the shot, not to press play.
          // Muted so a grid of previews never blares; controls to scrub.
          <video
            key={clip.id}
            src={clip.previewUrl}
            poster={clip.posterUrl ?? undefined}
            autoPlay
            loop
            muted
            controls
            playsInline
            className="mx-auto aspect-[9/16] w-full max-w-[260px] rounded-lg bg-black object-cover"
          />
        ) : (
          <div className="mx-auto flex aspect-[9/16] w-full max-w-[260px] items-center justify-center rounded-lg bg-muted p-4 text-center text-sm text-muted-foreground">
            This clip has no playable version yet — it may still be processing.
          </div>
        )}

        <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
          {meta && <span>{meta}</span>}
          {clip.isProductShot && (
            <Badge variant="secondary" className="text-[10px]">shows the product</Badge>
          )}
        </div>

        {editing ? (
          <ClipTagEditor
            clipId={clip.id}
            onSaved={() => {
              setEditing(false);
              onEdited?.();
            }}
            onCancel={() => setEditing(false)}
          />
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          {!editing && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4 mr-1" /> Edit tags
            </Button>
          )}
          {onRemove && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onRemove();
                onClose();
              }}
            >
              <Trash2 className="h-4 w-4 mr-1" /> Remove from video
            </Button>
          )}
          {onAdd && (
            <Button
              size="sm"
              onClick={() => {
                onAdd();
                onClose();
              }}
            >
              <Plus className="h-4 w-4 mr-1" /> Add to video
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Tag editor ───────────────────────────────────────────────────────────

interface SkuOption {
  id: string;
  sku: string | null;
  colorName: string | null;
  productName: string | null;
}
interface CategoryOption { id: string; name: string; archived?: number }

/**
 * Fix a clip's category, products and person, in place.
 *
 * The products tagged on a clip drive the composer's product-coherence
 * rules and the whole product-video build, so a wrong tag quietly
 * poisons everything downstream. It needs to be fixable from wherever
 * the mistake is noticed, not only from the library grid.
 *
 * Products are tagged at SKU level under the hood (the trend detector
 * keys on sku_id), but chosen here per PRODUCT — picking one selects all
 * of its colourways, which is how the rest of the app treats tagging.
 */
function ClipTagEditor({
  clipId,
  onSaved,
  onCancel,
}: {
  clipId: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [skus, setSkus] = useState<SkuOption[]>([]);
  const [categoryId, setCategoryId] = useState("");
  const [talent, setTalent] = useState("");
  const [skuIds, setSkuIds] = useState<Set<string>>(new Set());
  /** The tags as loaded — fixes the list order while you edit. */
  const [initialSkuIds, setInitialSkuIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [detail, cats, skuList] = await Promise.all([
        fetch(`/api/v1/marketing/videos/clips/${clipId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("/api/v1/marketing/videos/categories").then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("/api/v1/marketing/videos/skus").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (cancelled) return;
      const c = detail?.clip;
      setCategoryId(String(c?.category_id ?? ""));
      setTalent(String(c?.talent ?? ""));
      const tagged = new Set<string>((c?.products ?? []).map((p: { skuId: string }) => p.skuId));
      setSkuIds(tagged);
      setInitialSkuIds(tagged);
      setCategories((cats?.categories ?? []).filter((x: CategoryOption) => !x.archived));
      setSkus(skuList?.skus ?? skuList?.products?.flatMap((p: { skuIds: string[]; name: string }) =>
        p.skuIds.map((id) => ({ id, sku: null, colorName: null, productName: p.name }))) ?? []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [clipId]);

  /** SKUs collapsed to the products they belong to. */
  const products = useCallback(() => {
    const byProduct = new Map<string, { name: string; skuIds: string[] }>();
    for (const s of skus) {
      const name = s.productName ?? "Unnamed product";
      const entry = byProduct.get(name) ?? { name, skuIds: [] };
      entry.skuIds.push(s.id);
      byProduct.set(name, entry);
    }
    // What was ALREADY tagged floats to the top. You open this because a
    // tag is wrong, and a wrong tag you have to scroll a hundred products
    // to find is the thing that made it hard to fix in the first place.
    //
    // Ordered by the tags as LOADED, not as currently checked — otherwise
    // every click makes the row you just hit jump to the top and the list
    // reshuffle under the cursor.
    const list = [...byProduct.values()].sort((a, b) => {
      const aOn = a.skuIds.some((id) => initialSkuIds.has(id));
      const bOn = b.skuIds.some((id) => initialSkuIds.has(id));
      if (aOn !== bOn) return aOn ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const q = search.trim().toLowerCase();
    return q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list;
  }, [skus, search, initialSkuIds]);

  const toggleProduct = (ids: string[]) => {
    setSkuIds((prev) => {
      const next = new Set(prev);
      const on = ids.some((id) => next.has(id));
      for (const id of ids) { if (on) next.delete(id); else next.add(id); }
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/marketing/videos/clips/${clipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryId: categoryId || null,
          talent: talent.trim(),
          skuIds: [...skuIds],
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error ?? "Couldn't save tags");
        return;
      }
      toast.success("Clip tags updated");
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="h-40 animate-pulse rounded bg-muted" />;

  return (
    <div className="space-y-2 rounded-lg border p-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Type</span>
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="rounded border bg-background px-2 py-1"
          >
            <option value="">(untagged)</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Person</span>
          <Input
            value={talent}
            onChange={(e) => setTalent(e.target.value)}
            placeholder="no one"
            className="h-7 w-28 text-xs"
          />
        </label>
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Products in this clip</span>
          <Badge variant="secondary">{skuIds.size} SKUs</Badge>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search products…"
            className="h-7 flex-1 text-xs"
          />
        </div>
        <div className="max-h-44 space-y-0.5 overflow-y-auto rounded border p-1">
          {products().map((p) => {
            const on = p.skuIds.some((id) => skuIds.has(id));
            return (
              <label key={p.name} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-muted">
                <input type="checkbox" checked={on} onChange={() => toggleProduct(p.skuIds)} />
                <span className="truncate">{p.name}</span>
              </label>
            );
          })}
          {products().length === 0 && (
            <p className="p-2 text-muted-foreground">No products match.</p>
          )}
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
          Save tags
        </Button>
      </div>
    </div>
  );
}
