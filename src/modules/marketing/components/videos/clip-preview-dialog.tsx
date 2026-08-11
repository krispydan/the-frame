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

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Loader2, Plus, Trash2, X } from "lucide-react";

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

interface TaggedProduct { skuId: string; sku: string | null; productName: string | null; colorName: string | null }
interface SkuOption { id: string; sku: string; productName: string; colorName: string | null }

/**
 * The clip's tagged products, editable in place. Mis-tagged clips are
 * discovered while WATCHING them — so the fix lives here in the watch
 * dialog, not off in a separate review screen. Self-contained: fetches
 * the current tags itself and saves on every add/remove (the PATCH
 * replaces the whole set), so any page that mounts the dialog gets
 * tag-fixing without threading data through.
 */
function ClipProductTags({ clipId, onChanged }: { clipId: string; onChanged?: () => void }) {
  const [tags, setTags] = useState<TaggedProduct[] | null>(null);
  const [allSkus, setAllSkus] = useState<SkuOption[] | null>(null);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/v1/marketing/videos/clips/${clipId}`)
      .then((r) => r.json())
      .then((d) => alive && setTags(d.clip?.products ?? []))
      .catch(() => alive && setTags([]));
    return () => { alive = false; };
  }, [clipId]);

  // The SKU list loads lazily, first time the picker opens.
  useEffect(() => {
    if (!adding || allSkus) return;
    fetch("/api/v1/marketing/ads/options")
      .then((r) => r.json())
      .then((d) => setAllSkus(d.skus ?? []))
      .catch(() => setAllSkus([]));
  }, [adding, allSkus]);
  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const save = async (next: TaggedProduct[]) => {
    const prev = tags;
    setTags(next); // optimistic — reverted on failure
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/marketing/videos/clips/${clipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skuIds: next.map((t) => t.skuId) }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
      onChanged?.();
    } catch (e) {
      setTags(prev);
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const matches = useMemo(() => {
    if (!allSkus) return [];
    const tagged = new Set((tags ?? []).map((t) => t.skuId));
    const q = query.trim().toLowerCase();
    return allSkus
      .filter((s) => !tagged.has(s.id))
      .filter(
        (s) =>
          !q ||
          s.productName.toLowerCase().includes(q) ||
          s.sku.toLowerCase().includes(q) ||
          (s.colorName ?? "").toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [allSkus, tags, query]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        Products in this clip
        {saving && <Loader2 className="h-3 w-3 animate-spin" />}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {tags === null ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <>
            {tags.map((t) => (
              <span
                key={t.skuId}
                className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2.5 py-0.5 text-xs"
              >
                {t.productName ?? "?"} · {t.sku ?? t.skuId}
                <button
                  title="Untag"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => save(tags.filter((x) => x.skuId !== t.skuId))}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            {tags.length === 0 && <span className="text-xs text-muted-foreground">none tagged</span>}
            {!adding && (
              <button
                className="inline-flex items-center gap-0.5 rounded-full border border-dashed px-2.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setAdding(true)}
              >
                <Plus className="h-3 w-3" /> add
              </button>
            )}
          </>
        )}
      </div>
      {adding && (
        <div className="space-y-1">
          <Input
            ref={inputRef}
            placeholder="Search product, SKU, colour…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setAdding(false); setQuery(""); }
              if (e.key === "Enter" && matches.length === 1 && tags) {
                const s = matches[0];
                save([...tags, { skuId: s.id, sku: s.sku, productName: s.productName, colorName: s.colorName }]);
                setQuery("");
              }
            }}
            className="h-8 text-sm"
          />
          {allSkus === null ? (
            <div className="text-xs text-muted-foreground">loading catalog…</div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {matches.map((s) => (
                <button
                  key={s.id}
                  className="rounded-full border px-2.5 py-0.5 text-xs hover:bg-muted"
                  onClick={() => {
                    if (!tags) return;
                    save([...tags, { skuId: s.id, sku: s.sku, productName: s.productName, colorName: s.colorName }]);
                    setQuery("");
                  }}
                >
                  {s.productName} · {s.sku}
                </button>
              ))}
              {matches.length === 0 && query && (
                <span className="text-xs text-muted-foreground">no matches</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ClipPreviewDialog({
  clip,
  onClose,
  onAdd,
  onRemove,
  onTagsChanged,
}: {
  clip: PreviewClip;
  onClose: () => void;
  /** Shown when the clip isn't in the sequence yet. */
  onAdd?: () => void;
  /** Shown when it is. */
  onRemove?: () => void;
  /** Fires after the clip's product tags are edited + saved. */
  onTagsChanged?: () => void;
}) {
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

        <ClipProductTags clipId={clip.id} onChanged={onTagsChanged} />

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
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
