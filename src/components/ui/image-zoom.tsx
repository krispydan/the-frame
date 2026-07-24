"use client";

/**
 * ImageZoomDialog — click a thumbnail to inspect it large, with zoom.
 *
 * Small product tiles are often too small to read the frame detail the
 * AI is matching on. This opens the image in a dialog where you can
 * scroll to zoom, click to toggle a 2.5× zoom, and drag to pan when
 * zoomed in. Purely presentational — no dependency beyond the shared
 * Dialog primitive.
 */

import { useCallback, useRef, useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

const MIN = 1;
const MAX = 5;

export function ImageZoomDialog({
  url,
  label,
  onClose,
}: {
  url: string;
  label?: string;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const clamp = (s: number) => Math.min(MAX, Math.max(MIN, s));

  const reset = useCallback(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const zoomBy = (delta: number) =>
    setScale((s) => {
      const next = clamp(s + delta);
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 0.4 : -0.4);
  };

  const onDoubleTapToggle = () =>
    setScale((s) => {
      if (s > 1) {
        setPan({ x: 0, y: 0 });
        return 1;
      }
      return 2.5;
    });

  const onPointerDown = (e: React.PointerEvent) => {
    if (scale <= 1) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setPan({
      x: drag.current.px + (e.clientX - drag.current.x),
      y: drag.current.py + (e.clientY - drag.current.y),
    });
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[92vw] p-0 sm:max-w-2xl" showCloseButton={false}>
        <div
          className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-t-xl bg-neutral-950 select-none"
          onWheel={onWheel}
          onDoubleClick={onDoubleTapToggle}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          style={{ cursor: scale > 1 ? "grab" : "zoom-in", touchAction: "none" }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={label ?? ""}
            draggable={false}
            className="max-h-full max-w-full object-contain transition-transform duration-100"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
          />
          <div className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-black/50 p-1 backdrop-blur-sm">
            <Button size="icon-sm" variant="ghost" className="text-white hover:bg-white/20" onClick={() => zoomBy(-0.5)} title="Zoom out">
              <ZoomOut className="h-4 w-4" />
            </Button>
            <span className="w-10 text-center text-xs font-medium tabular-nums text-white">{scale.toFixed(1)}×</span>
            <Button size="icon-sm" variant="ghost" className="text-white hover:bg-white/20" onClick={() => zoomBy(0.5)} title="Zoom in">
              <ZoomIn className="h-4 w-4" />
            </Button>
            <Button size="icon-sm" variant="ghost" className="text-white hover:bg-white/20" onClick={reset} title="Reset">
              <RotateCcw className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {label && (
          <p className="px-4 pb-4 pt-1 text-center text-sm font-medium">{label}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
