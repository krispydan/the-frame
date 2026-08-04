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

  // Trim
  const [trimIdx, setTrimIdx] = useState<number | null>(null);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [trimming, setTrimming] = useState(false);
  const trimVideoRef = useRef<HTMLVideoElement | null>(null);

  // Reframe: zoom factor + normalized focal point.
  const [reframeIdx, setReframeIdx] = useState<number | null>(null);
  const [reframeZoom, setReframeZoom] = useState(1.4);
  const [reframeFocus, setReframeFocus] = useState({ x: 0.5, y: 0.42 });

  const totalDuration = clips.reduce((s, c) => s + (c.durationSec ?? 0), 0);

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

  const openTrim = (i: number) => {
    setTrimIdx(i);
    setTrimStart(0);
    setTrimEnd(Math.round((clips[i].durationSec ?? 0) * 10) / 10);
  };

  const applyTrim = async () => {
    if (trimIdx === null) return;
    const target = clips[trimIdx];
    setTrimming(true);
    try {
      const res = await fetch(`/api/v1/marketing/videos/clips/${target.id}/trim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startSec: trimStart, endSec: trimEnd }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error ?? "Trim failed");
        return;
      }
      replaceAt(trimIdx, d.clip as ApiClip);
      setTrimIdx(null);
      toast.success(
        d.deduped
          ? `That exact trim already existed — swapped it in. Hit ${saveLabel}.`
          : `Trimmed clip ready — hit ${saveLabel} to apply it.`,
      );
    } finally {
      setTrimming(false);
    }
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
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error ?? `${label} failed`);
        return false;
      }
      replaceAt(idx, d.clip as ApiClip);
      toast.success(
        d.deduped
          ? `${label} already existed — swapped it in. Hit ${saveLabel}.`
          : `${label} applied — hit ${saveLabel} to bake it in.`,
      );
      return true;
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

        {/* Trim */}
        {trimIdx !== null && clips[trimIdx] && (
          <div className="space-y-2 rounded-lg border p-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-xs font-medium">
                <Scissors className="h-3.5 w-3.5" /> Trim “{clips[trimIdx].fileName ?? "clip"}”
              </p>
              <Button variant="ghost" size="sm" onClick={() => setTrimIdx(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex flex-wrap items-start gap-3">
              <video
                ref={trimVideoRef}
                key={clips[trimIdx].id}
                src={clips[trimIdx].previewUrl ?? undefined}
                controls
                muted
                playsInline
                className="aspect-[9/16] w-36 rounded bg-muted object-cover"
              />
              <div className="min-w-[240px] flex-1 space-y-2">
                {(
                  [
                    ["Start", trimStart, setTrimStart],
                    ["End", trimEnd, setTrimEnd],
                  ] as Array<[string, number, (v: number) => void]>
                ).map(([label, value, setter]) => (
                  <div key={label} className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="w-9 text-xs font-medium">{label}</span>
                      <input
                        type="range"
                        min={0}
                        max={clips[trimIdx].durationSec ?? 0}
                        step={0.1}
                        value={value}
                        onChange={(e) => setter(Number(e.target.value))}
                        className="flex-1"
                      />
                      <span className="w-10 text-right text-xs tabular-nums">{value.toFixed(1)}s</span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-1.5 text-[11px]"
                        onClick={() => setter(Math.round((trimVideoRef.current?.currentTime ?? 0) * 10) / 10)}
                        title="Use the player's current position"
                      >
                        playhead
                      </Button>
                    </div>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">
                  Keeps {Math.max(0, trimEnd - trimStart).toFixed(1)}s of {(clips[trimIdx].durationSec ?? 0).toFixed(1)}s.
                  The original clip stays in the library; the trim becomes a new clip in this position.
                </p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={applyTrim} disabled={trimming || trimEnd - trimStart < 1}>
                    {trimming ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Scissors className="h-4 w-4 mr-1" />}
                    {trimming ? "Trimming…" : "Apply trim"}
                  </Button>
                  {trimEnd - trimStart < 1 && <span className="self-center text-xs text-amber-600">Minimum 1s</span>}
                </div>
              </div>
            </div>
          </div>
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
