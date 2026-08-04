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

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Trash2 } from "lucide-react";

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
}: {
  clip: PreviewClip;
  onClose: () => void;
  /** Shown when the clip isn't in the sequence yet. */
  onAdd?: () => void;
  /** Shown when it is. */
  onRemove?: () => void;
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
