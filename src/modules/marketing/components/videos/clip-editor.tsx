"use client";

/**
 * The clip editor — one implementation, used by every page that edits a
 * sequence of clips (social posts and product videos today).
 *
 * It was written for the post page first and then wanted on the product
 * page. Rather than copy it, it lives here: these tools are the core of
 * editing a video in the Frame, so every surface should get the same ones
 * and a fix in one place should reach all of them.
 *
 * What it owns: the filmstrip (watch / remove / reorder), the per-clip
 * tools (trim, reframe, punch-in, slow-mo, speed-up), and the two inline
 * dialogs those need.
 *
 * What it does NOT own: where new clips come from. The post page opens a
 * searchable library picker; the product page lists that product's other
 * footage. Both just pass `onAddClick`.
 *
 * Transforms are non-destructive — /trim and /transform each mint a NEW
 * content-addressed clip and the original stays in the library. The new
 * clip is swapped into the sequence in place, and the parent still has to
 * save to re-render.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ClipPreviewDialog } from "./clip-preview-dialog";
import { effectiveDuration } from "@/modules/marketing/lib/video/clip-trims";
import {
  ArrowLeft, ArrowRight, Clapperboard, Crop, FastForward, Focus, Loader2, Play, Plus, Rewind, Scissors, X,
} from "lucide-react";

/** The minimum a clip needs to be editable here. Callers may carry extra
 *  fields (e.g. the post page's `position`) — those are preserved. */
export interface EditorClip {
  id: string;
  fileName?: string;
  durationSec?: number | null;
  posterUrl?: string | null;
  previewUrl?: string | null;
  /** Caption under the thumbnail — usually the video type. The two pages
   *  name this field differently; all three spellings are accepted so
   *  neither page had to be reshaped to share the editor. */
  categoryName?: string | null;
  categorySlug?: string | null;
  category?: string | null;
  isProductShot?: boolean;
  /** Non-destructive in/out for THIS position in the sequence. Applied at
   *  render; the library clip is never modified. */
  trim?: { inSec: number; outSec: number } | null;
}

/** The label under a thumbnail, whichever field the caller populated. */
function clipLabel(c: EditorClip): string {
  return c.categoryName ?? c.category ?? c.categorySlug ?? c.fileName ?? "Clip";
}

/** What /trim and /transform hand back. */
interface ApiClip {
  id: string;
  fileName: string;
  durationSec: number | null;
  posterUrl: string | null;
  previewUrl: string | null;
  category?: string | null;
  categoryName?: string | null;
}

/**
 * Parse a response that might not be JSON.
 *
 * A 500 or a gateway timeout returns HTML, and `await res.json()` throws
 * there — which killed the handler before any toast fired, so a failed
 * trim looked like nothing happening at all.
 */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {
      error: res.status === 504 || res.status === 408
        ? "Timed out while processing the video — it may still finish; refresh in a minute"
        : `Server error (${res.status})`,
    };
  }
}

export function ClipEditor<T extends EditorClip>({
  clips,
  onChange,
  onSave,
  dirty,
  saving,
  saveLabel = "Save & re-render",
  savingLabel,
  minClips = 1,
  readOnly = false,
  readOnlyReason,
  onAddClick,
  onClipEdited,
  addLabel = "Add clip",
  title = "Clip editor",
  subtitle = "trim · reframe · add effects · reorder — this is your video, in order",
  warning,
  emptyHint = "No clips yet.",
  children,
}: {
  clips: T[];
  onChange: (next: T[]) => void;
  onSave: () => void;
  dirty: boolean;
  saving: boolean;
  saveLabel?: string;
  savingLabel?: string;
  /** Below this the remove buttons hide — a video needs some clips. */
  minClips?: number;
  readOnly?: boolean;
  readOnlyReason?: string;
  onAddClick?: () => void;
  /**
   * Called after a clip's tags are fixed from the preview dialog. The
   * editor only holds the sequence, not the clip records, so the host has
   * to refetch for the corrected category / products to show up.
   */
  onClipEdited?: () => void;
  addLabel?: string;
  title?: string;
  subtitle?: string;
  /** Caller-supplied banner (e.g. "no clip here shows the product"). */
  warning?: React.ReactNode;
  emptyHint?: string;
  /** Rendered at the end of the card — where a caller's own "add clips"
   *  panel lives, so it sits inside the editor rather than beside it. */
  children?: React.ReactNode;
}) {
  const [watchingIdx, setWatchingIdx] = useState<number | null>(null);
  const [fxBusyIdx, setFxBusyIdx] = useState<number | null>(null);

  // Trim — which position's panel is open. The trim itself lives on the
  // clip row, so setting one is local state, not a server round-trip.
  const [trimIdx, setTrimIdx] = useState<number | null>(null);

  // Reframe: zoom factor + normalized focal point.
  const [reframeIdx, setReframeIdx] = useState<number | null>(null);
  const [reframeZoom, setReframeZoom] = useState(1.4);
  const [reframeFocus, setReframeFocus] = useState({ x: 0.5, y: 0.42 });

  // Trimmed length — this readout is how long the finished video runs, so
  // it has to move the moment a handle does.
  const totalDuration = clips.reduce(
    (s, c) => s + effectiveDuration(c.durationSec ?? null, c.trim ?? null),
    0,
  );

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= clips.length) return;
    const next = [...clips];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  const remove = (i: number) => onChange(clips.filter((_, j) => j !== i));

  /** Swap a transformed clip into position `i`, keeping any extra fields
   *  the caller carries on the row (position, flags, …). */
  const replaceAt = (i: number, c: ApiClip) => {
    onChange(
      clips.map((row, j) =>
        j === i
          ? {
              ...row,
              id: c.id,
              fileName: c.fileName,
              durationSec: c.durationSec,
              posterUrl: c.posterUrl,
              previewUrl: c.previewUrl,
              categoryName: c.categoryName ?? c.category ?? row.categoryName,
              category: c.category ?? c.categoryName ?? row.category,
            }
          : row,
      ),
    );
  };

  const openTrim = (i: number) => setTrimIdx(i);

  /** Set (or clear) the trim on one position. Instant — no encode. */
  const setTrimAt = (i: number, trim: { inSec: number; outSec: number } | null) => {
    onChange(clips.map((row, j) => (j === i ? { ...row, trim } : row)));
  };

  const applyTransform = async (idx: number, spec: Record<string, unknown>, label: string) => {
    const target = clips[idx];
    if (!target) return false;
    setFxBusyIdx(idx);
    try {
      const res = await fetch(`/api/v1/marketing/videos/clips/${target.id}/transform`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(spec),
      });
      const d = await readJson(res);
      if (!res.ok) {
        toast.error(String(d.error ?? `${label} failed`), { duration: 10000 });
        return false;
      }
      replaceAt(idx, d.clip as ApiClip);
      toast.success(
        d.deduped
          ? `${label} already existed — swapped it in. Hit ${saveLabel}.`
          : `${label} applied — hit ${saveLabel} to bake it in.`,
      );
      return true;
    } catch (e) {
      toast.error(`${label} failed: ${e instanceof Error ? e.message : String(e)}`, { duration: 10000 });
      return false;
    } finally {
      setFxBusyIdx(null);
    }
  };

  const openReframe = (i: number) => {
    setReframeIdx(i);
    setReframeZoom(1.4);
    setReframeFocus({ x: 0.5, y: 0.42 });
  };

  const applyReframe = async () => {
    if (reframeIdx === null) return;
    const ok = await applyTransform(
      reframeIdx,
      { kind: "reframe", zoom: reframeZoom, x: reframeFocus.x, y: reframeFocus.y },
      "Reframe",
    );
    if (ok) setReframeIdx(null);
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <Clapperboard className="h-4 w-4" /> {title}
          <span className="text-xs font-normal text-muted-foreground">{subtitle}</span>
          <span className="ml-auto flex items-center gap-2">
            <span className="text-xs font-normal text-muted-foreground">
              {clips.length} clips · {totalDuration.toFixed(1)}s
            </span>
            {onAddClick && !readOnly && (
              <Button variant="outline" size="sm" onClick={onAddClick}>
                <Plus className="h-4 w-4 mr-1" /> {addLabel}
              </Button>
            )}
            <Button
              size="sm"
              onClick={onSave}
              disabled={saving || !dirty || clips.length === 0 || readOnly}
              title={readOnly ? readOnlyReason : undefined}
            >
              {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
              {saving && savingLabel ? savingLabel : saveLabel}
            </Button>
          </span>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3">
        {warning}
        {dirty && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700">
            Unsaved changes — hit <b>{saveLabel}</b> to bake your edits into the video.
          </p>
        )}

        {/* Filmstrip — the sequence, left to right */}
        <div className="flex gap-2 overflow-x-auto pb-1">
          {clips.map((c, i) => {
            const busy = fxBusyIdx === i;
            return (
              <div key={`${c.id}-${i}`} className="group/clip w-32 shrink-0">
                <div className="relative aspect-[9/16] overflow-hidden rounded-lg border bg-muted">
                  {/* The poster is the play surface — click to watch it. */}
                  <button
                    type="button"
                    onClick={() => setWatchingIdx(i)}
                    title="Watch this clip"
                    className="absolute inset-0 h-full w-full"
                  >
                    {c.posterUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.posterUrl} alt="" className="h-full w-full object-cover" />
                    ) : null}
                    <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover/clip:bg-black/25 group-hover/clip:opacity-100">
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-black">
                        <Play className="h-4 w-4 translate-x-px fill-current" />
                      </span>
                    </span>
                  </button>
                  <span className="pointer-events-none absolute left-1 top-1 z-10 flex h-5 min-w-5 items-center justify-center rounded-full bg-black/70 px-1 text-[10px] font-semibold text-white">
                    {i + 1}
                  </span>
                  {c.durationSec != null && (
                    <span className="pointer-events-none absolute bottom-1 right-1 z-10 rounded bg-black/70 px-1 text-[10px] font-medium text-white">
                      {c.durationSec.toFixed(1)}s
                    </span>
                  )}
                  {!readOnly && (
                    <>
                      <button
                        onClick={() => remove(i)}
                        disabled={clips.length <= minClips}
                        title={clips.length <= minClips ? "A video needs at least one clip" : "Remove clip"}
                        className="absolute z-20 right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition hover:bg-red-600 group-hover/clip:opacity-100 disabled:hidden"
                      >
                        <X className="h-3 w-3" />
                      </button>
                      <button
                        onClick={() => move(i, -1)}
                        disabled={i === 0}
                        title="Move earlier"
                        className="absolute z-20 left-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white opacity-0 transition hover:bg-black/70 group-hover/clip:opacity-100 disabled:hidden"
                      >
                        <ArrowLeft className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => move(i, 1)}
                        disabled={i === clips.length - 1}
                        title="Move later"
                        className="absolute z-20 right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white opacity-0 transition hover:bg-black/70 group-hover/clip:opacity-100 disabled:hidden"
                      >
                        <ArrowRight className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                  {busy && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                      <Loader2 className="h-5 w-5 animate-spin text-white" />
                    </div>
                  )}
                </div>

                {/* Per-clip tools */}
                {!readOnly && (
                  <div className="mt-1 flex items-center justify-center gap-0.5">
                    <Button variant="ghost" size="icon-xs" onClick={() => openTrim(i)} disabled={busy || !c.previewUrl} title="Trim — cut at a different point">
                      <Scissors />
                    </Button>
                    <Button variant="ghost" size="icon-xs" onClick={() => openReframe(i)} disabled={busy || !c.previewUrl} title="Reframe — zoom / crop tighter">
                      <Crop />
                    </Button>
                    <Button variant="ghost" size="icon-xs" onClick={() => applyTransform(i, { kind: "punch" }, "Punch-in")} disabled={busy || !c.previewUrl} title="Punch-in — slow Ken Burns zoom">
                      <Focus />
                    </Button>
                    <Button variant="ghost" size="icon-xs" onClick={() => applyTransform(i, { kind: "speed", factor: 0.5 }, "Slow-mo")} disabled={busy || !c.previewUrl} title="Slow-mo (0.5×)">
                      <Rewind />
                    </Button>
                    <Button variant="ghost" size="icon-xs" onClick={() => applyTransform(i, { kind: "speed", factor: 2 }, "Speed-up")} disabled={busy || !c.previewUrl} title="Speed up (2×)">
                      <FastForward />
                    </Button>
                  </div>
                )}
                <p className="truncate text-center text-[10px] text-muted-foreground" title={c.fileName}>
                  {clipLabel(c)}
                </p>
              </div>
            );
          })}

          {clips.length === 0 && <p className="p-3 text-sm text-muted-foreground">{emptyHint}</p>}

          {onAddClick && !readOnly && (
            <button
              onClick={onAddClick}
              className="flex aspect-[9/16] w-32 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-muted-foreground hover:bg-muted"
              title="Add a clip"
            >
              <Plus className="h-5 w-5" />
              <span className="text-xs">{addLabel}</span>
            </button>
          )}
        </div>

        {/* Trim — non-destructive in/out on this position */}
        {trimIdx !== null && clips[trimIdx] && (
          <TrimPanel
            clip={clips[trimIdx]}
            trim={clips[trimIdx].trim ?? null}
            onChange={(t) => setTrimAt(trimIdx, t)}
            onClose={() => setTrimIdx(null)}
          />
        )}

        {/* Reframe — drag the box, or pick a position */}
        {reframeIdx !== null && clips[reframeIdx] && (
          <ReframePanel
            clip={clips[reframeIdx]}
            zoom={reframeZoom}
            focus={reframeFocus}
            onZoom={setReframeZoom}
            onFocus={setReframeFocus}
            onApply={applyReframe}
            onClose={() => setReframeIdx(null)}
            busy={fxBusyIdx === reframeIdx}
          />
        )}

        {children}
      </CardContent>

      {watchingIdx !== null && clips[watchingIdx] && (
        <ClipPreviewDialog
          clip={clips[watchingIdx]}
          onClose={() => setWatchingIdx(null)}
          onEdited={onClipEdited}
          onRemove={
            readOnly || clips.length <= minClips
              ? undefined
              : () => {
                  remove(watchingIdx);
                  setWatchingIdx(null);
                }
          }
        />
      )}
    </Card>
  );
}

// ── Reframe ──────────────────────────────────────────────────────────────

/**
 * Choose WHAT the tighter crop keeps.
 *
 * The first version only let you click a small thumbnail to re-centre,
 * with no handle to grab and no way to say "keep the bottom". Since the
 * default focal point sits above centre, anyone who adjusted the zoom
 * without discovering the click got a crop near the top of the frame
 * every time — which read as "it only crops from the top".
 *
 * So position is now stated three ways, and they all drive the same
 * focal point: drag the box, pick a cell in the 3x3 grid, or read the
 * exact percentages. The backdrop is the clip playing rather than its
 * poster, because the right crop depends on the moment you're framing.
 */
function ReframePanel({
  clip,
  zoom,
  focus,
  onZoom,
  onFocus,
  onApply,
  onClose,
  busy,
}: {
  clip: EditorClip;
  zoom: number;
  focus: { x: number; y: number };
  onZoom: (z: number) => void;
  onFocus: (f: { x: number; y: number }) => void;
  onApply: () => void;
  onClose: () => void;
  busy: boolean;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  /** Pointer position → normalized focal point, clamped to the frame. */
  const focusAt = useCallback((clientX: number, clientY: number) => {
    const el = frameRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    onFocus({
      x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)),
    });
  }, [onFocus]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => focusAt(e.clientX, e.clientY);
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, focusAt]);

  // The crop window as a percentage of the frame, clamped the same way
  // the ffmpeg crop is — so the preview can't promise a framing the
  // encoder won't produce.
  const boxPct = 100 / zoom;
  const left = Math.min(100 - boxPct, Math.max(0, focus.x * 100 - boxPct / 2));
  const top = Math.min(100 - boxPct, Math.max(0, focus.y * 100 - boxPct / 2));

  return (
    <div className="space-y-2 rounded-lg border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium">
          <Crop className="h-3.5 w-3.5" /> Reframe “{clip.fileName ?? "clip"}” — zoom in for a tighter shot
        </p>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex flex-wrap items-start gap-3">
        <div
          ref={frameRef}
          className="relative aspect-[9/16] w-48 shrink-0 select-none overflow-hidden rounded bg-muted"
          onMouseDown={(e) => {
            e.preventDefault();
            focusAt(e.clientX, e.clientY);
            setDragging(true);
          }}
          title="Drag to choose what the crop keeps"
        >
          {/* The clip itself, scrubbable — the right crop depends on the
              moment, which a single poster frame can't tell you. */}
          {clip.previewUrl ? (
            <video
              src={clip.previewUrl}
              poster={clip.posterUrl ?? undefined}
              muted
              playsInline
              loop
              autoPlay
              className="pointer-events-none h-full w-full object-cover"
            />
          ) : clip.posterUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={clip.posterUrl} alt="" className="pointer-events-none h-full w-full object-cover" />
          ) : null}

          {/* Everything outside the box is dimmed by the huge spread shadow. */}
          <div
            className={`pointer-events-none absolute border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] ${
              dragging ? "cursor-grabbing" : "cursor-grab"
            }`}
            style={{ left: `${left}%`, top: `${top}%`, width: `${boxPct}%`, height: `${boxPct}%` }}
          >
            {/* Centre mark — makes it obvious the box is draggable. */}
            <span className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-black/40" />
          </div>
        </div>

        <div className="min-w-[260px] flex-1 space-y-2.5">
          <div className="flex items-center gap-2">
            <span className="w-12 text-xs font-medium">Zoom</span>
            <input
              type="range"
              min={1.05}
              max={2.5}
              step={0.05}
              value={zoom}
              onChange={(e) => onZoom(Number(e.target.value))}
              className="flex-1"
            />
            <span className="w-10 text-right text-xs tabular-nums">{zoom.toFixed(2)}×</span>
          </div>

          {/* Explicit positions — the fastest way to say "keep the bottom". */}
          <div className="space-y-1">
            <span className="text-xs font-medium">Crop from</span>
            <div className="flex items-start gap-2">
              <div className="grid w-[84px] grid-cols-3 gap-0.5">
                {REFRAME_ANCHORS.map((a) => {
                  const active = Math.abs(focus.x - a.x) < 0.02 && Math.abs(focus.y - a.y) < 0.02;
                  return (
                    <button
                      key={a.label}
                      type="button"
                      onClick={() => onFocus({ x: a.x, y: a.y })}
                      title={a.label}
                      className={`h-6 rounded border text-[9px] leading-none ${
                        active ? "border-primary bg-primary/15 font-semibold" : "hover:bg-muted"
                      }`}
                    >
                      {a.short}
                    </button>
                  );
                })}
              </div>
              <p className="flex-1 text-[11px] text-muted-foreground">
                Drag the box on the frame, or pick a position. Currently{" "}
                <b className="tabular-nums">{Math.round(focus.x * 100)}% across, {Math.round(focus.y * 100)}% down</b>.
              </p>
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground">
            The original clip is untouched — the reframe becomes a new clip in this position.
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={onApply} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Crop className="h-4 w-4 mr-1" />}
              {busy ? "Reframing…" : "Apply reframe"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 3x3 focal points, in grid order. */
const REFRAME_ANCHORS = [
  { label: "Top left", short: "↖", x: 0.2, y: 0.18 },
  { label: "Top", short: "↑", x: 0.5, y: 0.18 },
  { label: "Top right", short: "↗", x: 0.8, y: 0.18 },
  { label: "Left", short: "←", x: 0.2, y: 0.5 },
  { label: "Centre", short: "•", x: 0.5, y: 0.5 },
  { label: "Right", short: "→", x: 0.8, y: 0.5 },
  { label: "Bottom left", short: "↙", x: 0.2, y: 0.82 },
  { label: "Bottom", short: "↓", x: 0.5, y: 0.82 },
  { label: "Bottom right", short: "↘", x: 0.8, y: 0.82 },
];

// ── Trim ─────────────────────────────────────────────────────────────────

/**
 * Set a clip's in/out points, seeing the frame you're landing on.
 *
 * The old panel was two range sliders next to an unrelated player, so you
 * chose cut points blind. Here one preview retargets to whichever handle
 * you're dragging and snaps back to the playhead on release — the pattern
 * every consumer editor uses. (Two side-by-side previews are a
 * professional NLE convention for trimming the join BETWEEN two clips;
 * with a single clip against nothing they'd show the same thing twice.)
 *
 * Seeking uses chase-time coalescing rather than a throttle: issue the
 * next seek only when the last one reports back, always to the newest
 * position. A timer-based throttle is decoupled from how long a seek
 * actually takes, so it either floods the decoder or adds latency for
 * nothing.
 *
 * Nothing here calls the server. The trim is two numbers on the sequence,
 * baked in at render.
 */
function TrimPanel({
  clip,
  trim,
  onChange,
  onClose,
}: {
  clip: EditorClip;
  trim: { inSec: number; outSec: number } | null;
  onChange: (t: { inSec: number; outSec: number } | null) => void;
  onClose: () => void;
}) {
  // The probed duration is the DB's, and a handful of clips have never
  // been probed (durationSec null) — those would render a zero-width
  // timeline you can't drag. The <video> element knows its own length, so
  // adopt that as soon as metadata lands and the panel works regardless.
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);
  const duration = mediaDuration ?? clip.durationSec ?? 0;
  const inSec = trim?.inSec ?? 0;
  const outSec = trim?.outSec ?? duration;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [playhead, setPlayhead] = useState(inSec);
  const [drag, setDrag] = useState<"in" | "out" | "playhead" | null>(null);
  const [filmstripUrl, setFilmstripUrl] = useState<string | null>(null);

  // ── Chase-time seeking ──
  // `seeking` guards a seek in flight; when it lands we re-fire only if
  // the target moved. The watchdog exists because 'seeked' occasionally
  // doesn't fire, which would otherwise deadlock the drag.
  const chase = useRef({ target: 0, seeking: false, timer: 0 as number | ReturnType<typeof setTimeout> });
  const seekTo = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    const c = chase.current;
    c.target = Math.max(0, Math.min(duration, t));
    setPlayhead(c.target);
    if (c.seeking) return;
    c.seeking = true;
    v.currentTime = c.target;
    clearTimeout(c.timer);
    c.timer = setTimeout(() => { c.seeking = false; }, 250);
  }, [duration]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onSeeked = () => {
      const c = chase.current;
      clearTimeout(c.timer);
      // Float comparison never lands exactly — an epsilon, not equality.
      if (Math.abs(v.currentTime - c.target) < 0.02) {
        c.seeking = false;
      } else {
        v.currentTime = c.target;
        c.timer = setTimeout(() => { c.seeking = false; }, 250);
      }
    };
    v.addEventListener("seeked", onSeeked);
    const c = chase.current;
    return () => {
      v.removeEventListener("seeked", onSeeked);
      clearTimeout(c.timer);
    };
  }, []);

  // Filmstrip behind the track — decoration, so failure is silent.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/marketing/videos/clips/${clip.id}/filmstrip`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) setFilmstripUrl(d?.url ?? null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [clip.id]);

  const pct = (t: number) => (duration > 0 ? (t / duration) * 100 : 0);
  const timeAt = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el || duration <= 0) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
  }, [duration]);

  /**
   * Emit a range, or null when it covers the whole clip.
   *
   * Without the null case, opening the panel and nudging a handle back to
   * the edge leaves a {0, duration} "trim" behind: it marks the post
   * dirty, survives a save, and forces the render off its stream-copy
   * path to re-encode a cut that removes nothing.
   */
  const emit = useCallback((nextIn: number, nextOut: number) => {
    const i = roundFrame(nextIn);
    const o = roundFrame(nextOut);
    // Half a frame, NOT a millisecond: snapping to the frame grid moves
    // the out point by up to 1/60s, so a clip of 4.806s rounds to 4.80.
    // Against a 1ms threshold that reads as "not the whole clip", and
    // dragging the handle back to the end would leave a trim behind that
    // cuts six milliseconds — dirtying the post and costing a re-encode.
    const halfFrame = 1 / 60;
    const whole = i <= halfFrame && (duration <= 0 || o >= duration - halfFrame);
    onChange(whole ? null : { inSec: i, outSec: o });
  }, [duration, onChange]);

  const setIn = useCallback((t: number) => {
    emit(Math.max(0, Math.min(t, outSec - MIN_TRIM_SEC)), outSec);
  }, [outSec, emit]);
  const setOut = useCallback((t: number) => {
    emit(inSec, Math.min(duration, Math.max(t, inSec + MIN_TRIM_SEC)));
  }, [inSec, duration, emit]);

  // ── Dragging ──
  // The handlers live in refs and the listeners are attached IMPERATIVELY
  // in pointerdown, rather than by an effect keyed on `drag`.
  //
  // An effect can only attach after React commits the setDrag render, and
  // a quick flick puts several pointermove events on the wire before that
  // — they land on nothing, so the first part of the gesture is silently
  // dropped and the handle appears to stick. Attaching inside the same
  // event that starts the drag closes that window; pointer capture then
  // keeps the events coming even when the cursor leaves the track.
  const live = useRef({ inSec, outSec, setIn, setOut, seekTo, timeAt });
  // Synced after commit, not during render: a pointer event can only be
  // handled after the browser yields, so the drag always reads current
  // values.
  useEffect(() => {
    live.current = { inSec, outSec, setIn, setOut, seekTo, timeAt };
  });

  const startDrag = useCallback((which: "in" | "out" | "playhead", e: React.PointerEvent) => {
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture?.(e.pointerId);
    setDrag(which);

    const onMove = (ev: PointerEvent) => {
      const l = live.current;
      const t = l.timeAt(ev.clientX);
      if (which === "in") { l.setIn(t); l.seekTo(Math.min(t, l.outSec - MIN_TRIM_SEC)); }
      else if (which === "out") { l.setOut(t); l.seekTo(Math.max(t, l.inSec + MIN_TRIM_SEC)); }
      else l.seekTo(t);
    };
    // Release returns the preview to the in-point — the frame the clip
    // will actually open on.
    const onUp = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      if (which !== "playhead") live.current.seekTo(live.current.inSec);
      setDrag(null);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);

    if (which === "playhead") onMove(e.nativeEvent);
  }, []);

  // ── Keyboard: editor conventions ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const frame = 1 / 30;
      if (e.key === "i" || e.key === "I") { e.preventDefault(); setIn(playhead); }
      else if (e.key === "o" || e.key === "O") { e.preventDefault(); setOut(playhead); }
      else if (e.key === "," ) { e.preventDefault(); seekTo(playhead - frame); }
      else if (e.key === "." ) { e.preventDefault(); seekTo(playhead + frame); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); seekTo(playhead - (e.shiftKey ? 1 : frame)); }
      else if (e.key === "ArrowRight") { e.preventDefault(); seekTo(playhead + (e.shiftKey ? 1 : frame)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playhead, setIn, setOut, seekTo]);

  const kept = Math.max(0, outSec - inSec);
  const trimmed = kept < duration - 0.05;

  return (
    <div className="space-y-2 rounded-lg border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium">
          <Scissors className="h-3.5 w-3.5" /> Trim “{clip.fileName ?? "clip"}”
        </p>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex flex-wrap items-start gap-3">
        <video
          ref={videoRef}
          src={clip.previewUrl ?? undefined}
          poster={clip.posterUrl ?? undefined}
          muted
          playsInline
          preload="auto"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setMediaDuration(d);
            seekTo(inSec);
          }}
          className="aspect-[9/16] w-44 shrink-0 rounded bg-black object-cover"
        />

        <div className="min-w-[300px] flex-1 space-y-2">
          {/* Timeline: kept range bright, discarded ends dimmed */}
          <div
            ref={trackRef}
            className="relative h-14 w-full cursor-pointer select-none overflow-hidden rounded border bg-muted bg-cover"
            style={filmstripUrl ? { backgroundImage: `url(${filmstripUrl})`, backgroundSize: "100% 100%" } : undefined}
            onPointerDown={(e) => startDrag("playhead", e)}
          >
            <div className="pointer-events-none absolute inset-y-0 left-0 bg-black/60" style={{ width: `${pct(inSec)}%` }} />
            <div className="pointer-events-none absolute inset-y-0 right-0 bg-black/60" style={{ width: `${100 - pct(outSec)}%` }} />
            {/* Handles sit ON the boundary with a generous hit area. */}
            {([["in", inSec], ["out", outSec]] as const).map(([which, at]) => (
              <div
                key={which}
                onPointerDown={(e) => { e.stopPropagation(); startDrag(which, e); }}
                className="absolute inset-y-0 z-10 flex w-4 cursor-ew-resize items-center justify-center"
                // Nudged inward at the extremes instead of centred on the
                // boundary: the track is overflow-hidden, so a handle at 0%
                // or 100% would have half its hit area clipped away and be
                // almost impossible to grab — exactly where an untrimmed
                // clip puts both of them.
                style={{
                  left: `${pct(at)}%`,
                  transform: `translateX(${-Math.min(100, Math.max(0, pct(at)))}%)`,
                }}
                title={which === "in" ? "Drag the start" : "Drag the end"}
                role="slider"
                aria-label={which === "in" ? "Trim start" : "Trim end"}
                aria-valuemin={0}
                aria-valuemax={duration}
                aria-valuenow={at}
                aria-valuetext={`${at.toFixed(2)} seconds`}
              >
                {/* Widened while held, so it's obvious which end you have. */}
                <span className={`h-full rounded bg-primary shadow ${drag === which ? "w-1.5" : "w-1"}`} />
              </div>
            ))}
            <div className="pointer-events-none absolute inset-y-0 z-20 w-0.5 bg-white mix-blend-difference" style={{ left: `${pct(playhead)}%` }} />
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            {/* 2dp, because a frame is 0.03s — 1dp would show three
                distinct in-points as the same number. */}
            <span className="tabular-nums text-muted-foreground">
              in {inSec.toFixed(2)}s · out {outSec.toFixed(2)}s
            </span>
            <span className={trimmed ? "font-medium" : "text-muted-foreground"}>
              keeps {kept.toFixed(1)}s of {duration.toFixed(1)}s
            </span>
            <div className="flex-1" />
            <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setIn(playhead)}>
              Set in
            </Button>
            <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setOut(playhead)}>
              Set out
            </Button>
            {trimmed && (
              <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => onChange(null)}>
                Reset
              </Button>
            )}
          </div>

          <p className="text-[11px] text-muted-foreground">
            Nothing is re-encoded — the trim is applied when the video renders, and can be widened again or
            reset at any time. <b>I</b>/<b>O</b> set in/out at the playhead · <b>,</b>/<b>.</b> step one frame.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Matches MIN_TRIM_SEC in clip-trims.ts — the server rejects less. */
const MIN_TRIM_SEC = 1;

/**
 * Snap to the frame grid, not to a tenth of a second.
 *
 * The panel advertises single-frame stepping (`,` / `.`); rounding the
 * result to 0.1s would quantize three frames into one and make the keys
 * do nothing visible. 30fps is the canonical normalized rate.
 */
function roundFrame(n: number): number {
  return Math.round(n * 30) / 30;
}
