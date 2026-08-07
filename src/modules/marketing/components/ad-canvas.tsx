"use client";

/**
 * Drag-and-drop canvas for one ad ratio.
 *
 * The preview IS the render's math: this component imports the same
 * pure libs the server renderer uses (cropWindow, effectiveLayout,
 * card geometry fractions), so what you drag here is what ffmpeg
 * composites. Coordinates stay normalized 0–1 of frame width/height —
 * the only conversion is to this container's pixels for display.
 *
 * Interactions:
 *   drag the card        → cardX / cardY
 *   drag its corner dot  → cardW (uniform scale; height follows aspect)
 *   drag the background  → bgOffsetX / bgOffsetY (slides the crop window)
 */

import { useCallback, useRef } from "react";
import { AD_RATIOS, cropWindow, type AdRatio } from "@/modules/marketing/lib/ads/ratios";
import type { RatioLayout } from "@/modules/marketing/lib/ads/recipes";

// Card-local fractions — MUST mirror buildCard() in lib/ads/card.ts.
const PAD_FRAC = 0.045;
const RADIUS_FRAC = 0.035;
const BAND_FRAC = 0.24;

export interface AdCanvasProps {
  ratio: AdRatio;
  layout: RatioLayout;
  cardAspect: number;
  backgroundUrl: string | null;
  cardImageUrl: string | null;
  cardText: string;
  /** Source media dimensions — drives the exact crop-window preview. */
  srcWidth: number;
  srcHeight: number;
  width?: number; // container px
  onChange: (patch: Partial<RatioLayout>) => void;
}

export function AdCanvas({
  ratio, layout, cardAspect, backgroundUrl, cardImageUrl, cardText,
  srcWidth, srcHeight, width = 260, onChange,
}: AdCanvasProps) {
  const frame = AD_RATIOS[ratio];
  const height = Math.round((width * frame.height) / frame.width);
  const ref = useRef<HTMLDivElement>(null);

  // Exact crop-window position, same function the renderer calls.
  const crop = cropWindow(srcWidth, srcHeight, ratio, layout.bgOffsetX, layout.bgOffsetY);
  const slackX = srcWidth - crop.width;
  const slackY = srcHeight - crop.height;
  const posX = slackX > 0 ? (crop.x / slackX) * 100 : 50;
  const posY = slackY > 0 ? (crop.y / slackY) * 100 : 50;

  const cardW = layout.cardW * width;
  const cardH = cardW / cardAspect;
  const cardX = layout.cardX * width;
  const cardY = layout.cardY * height;
  const pad = cardW * PAD_FRAC;
  const bandH = cardH * BAND_FRAC;

  type Mode = "card" | "scale" | "bg";
  const drag = useRef<{ mode: Mode; startX: number; startY: number; base: RatioLayout } | null>(null);

  const onPointerDown = useCallback((mode: Mode) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { mode, startX: e.clientX, startY: e.clientY, base: { ...layout } };
  }, [layout]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.mode === "card") {
      onChange({ cardX: d.base.cardX + dx / width, cardY: d.base.cardY + dy / height });
    } else if (d.mode === "scale") {
      // Corner drag: new width from pointer distance to the card's left edge.
      const newW = Math.min(1.5, Math.max(0.15, d.base.cardW + dx / width));
      onChange({ cardW: newW });
    } else {
      // Background slide: pixel delta → source px → fraction of slack.
      // scale: container px per source px of the crop window.
      const scale = width / crop.width;
      const patch: Partial<RatioLayout> = {};
      if (slackX > 0) patch.bgOffsetX = clamp(d.base.bgOffsetX - dx / scale / slackX, -0.5, 0.5);
      if (slackY > 0) patch.bgOffsetY = clamp(d.base.bgOffsetY - dy / scale / slackY, -0.5, 0.5);
      if (Object.keys(patch).length) onChange(patch);
    }
  }, [onChange, width, height, crop.width, slackX, slackY]);

  const onPointerUp = useCallback(() => { drag.current = null; }, []);

  return (
    <div
      ref={ref}
      className="relative select-none overflow-hidden rounded-lg border bg-black touch-none"
      style={{ width, height }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      {/* Background = the crop-window view of the raw source. */}
      {backgroundUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={backgroundUrl}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full cursor-grab object-cover active:cursor-grabbing"
          style={{ objectPosition: `${posX}% ${posY}%` }}
          onPointerDown={onPointerDown("bg")}
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center text-xs text-white/50">no preview</div>
      )}

      {/* The card — same geometry fractions as the sharp builder. */}
      <div
        className="absolute cursor-move bg-white shadow-md"
        style={{
          left: cardX, top: cardY, width: cardW, height: cardH,
          borderRadius: cardW * RADIUS_FRAC,
        }}
        onPointerDown={onPointerDown("card")}
      >
        <div
          className="absolute flex items-center justify-center"
          style={{ left: pad, top: pad, right: pad, bottom: bandH + pad / 2 }}
        >
          {cardImageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={cardImageUrl} alt="" draggable={false} className="max-h-full max-w-full object-contain" />
          )}
        </div>
        {cardText && (
          <div
            className="absolute inset-x-0 flex items-center justify-center font-bold tracking-wide text-black"
            style={{ bottom: pad / 2, height: bandH, fontSize: Math.max(6, bandH * 0.42) }}
          >
            {cardText.toUpperCase()}
          </div>
        )}
        {/* Scale handle */}
        <div
          className="absolute -bottom-1.5 -right-1.5 h-3.5 w-3.5 cursor-nwse-resize rounded-full border-2 border-white bg-primary shadow"
          onPointerDown={onPointerDown("scale")}
        />
      </div>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), hi);
}
