"use client";

/**
 * Timeline splitter — carve a long clip into several short ones.
 *
 * The job is repetitive (dozens of clips, several segments each), so
 * everything here is built around removing seconds from each pass:
 *
 *  • Segments arrive PRE-PLACED from scene detection. Adjusting two
 *    handles beats drawing a range from nothing, every time.
 *  • Dragging SNAPS to detected scene cuts, so a shot boundary lands
 *    exactly rather than approximately. Hold Alt to ignore snapping.
 *  • Everything has a key. The mouse round-trip is the real cost.
 *
 * Segments may overlap — the same moment can legitimately serve two
 * clips — but each must clear MIN_SEGMENT_SEC, which the cut would
 * reject anyway.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Scissors, Trash2, Wand2 } from "lucide-react";

export interface Segment {
  startSec: number;
  endSec: number;
}

/** Mirrors split-review.ts — kept in sync by a test. */
export const MIN_SEGMENT_SEC = 1;
export const TARGET_MIN_SEC = 3;
export const TARGET_MAX_SEC = 5;
/** Within this many seconds, a drag snaps to a scene cut. */
const SNAP_SEC = 0.25;

type DragState =
  | { kind: "move"; index: number; grabOffset: number }
  | { kind: "start"; index: number }
  | { kind: "end"; index: number }
  | null;

export function clampSegment(s: Segment, duration: number): Segment {
  const start = Math.max(0, Math.min(s.startSec, duration - MIN_SEGMENT_SEC));
  const end = Math.min(duration, Math.max(s.endSec, start + MIN_SEGMENT_SEC));
  return { startSec: round1(start), endSec: round1(end) };
}

/** Nearest scene cut within SNAP_SEC, else the value unchanged. */
export function snapTo(value: number, cuts: number[], enabled = true): number {
  if (!enabled || cuts.length === 0) return value;
  let best = value;
  let bestDist = SNAP_SEC;
  for (const c of cuts) {
    const d = Math.abs(c - value);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Colour cue: too short to cut, longer than the composer likes, or good. */
export function segmentTone(lengthSec: number): "bad" | "warn" | "good" {
  if (lengthSec < MIN_SEGMENT_SEC) return "bad";
  if (lengthSec > TARGET_MAX_SEC + 1) return "warn";
  return "good";
}

const TONE_CLASS: Record<string, string> = {
  bad: "bg-red-500/35 border-red-500",
  warn: "bg-amber-500/30 border-amber-500",
  good: "bg-emerald-500/30 border-emerald-500",
};

export function ClipSplitter({
  previewUrl,
  durationSec,
  sceneCuts,
  segments,
  onChange,
  onSuggest,
  suggesting = false,
  disabled = false,
  filmstripUrl,
}: {
  previewUrl: string | null;
  durationSec: number;
  sceneCuts: number[];
  segments: Segment[];
  onChange: (next: Segment[]) => void;
  /** Re-run scene detection and replace the segments. */
  onSuggest?: () => void;
  suggesting?: boolean;
  disabled?: boolean;
  /** Wide thumbnail strip drawn behind the track — shot changes at a
   *  glance, so the scene markers mean something. */
  filmstripUrl?: string | null;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [drag, setDrag] = useState<DragState>(null);
  const [selected, setSelected] = useState<number | null>(segments.length > 0 ? 0 : null);
  // Alt held = ignore snapping, for when a cut must land off a boundary.
  const noSnapRef = useRef(false);

  const pctOf = (sec: number) => (durationSec > 0 ? (sec / durationSec) * 100 : 0);

  const secAtClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || durationSec <= 0) return 0;
      const r = el.getBoundingClientRect();
      return Math.max(0, Math.min(durationSec, ((clientX - r.left) / r.width) * durationSec));
    },
    [durationSec],
  );

  const seek = useCallback((sec: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = Math.max(0, sec);
    setPlayhead(sec);
  }, []);

  const update = useCallback(
    (i: number, next: Segment) => {
      onChange(segments.map((s, j) => (j === i ? clampSegment(next, durationSec) : s)));
    },
    [segments, onChange, durationSec],
  );

  const addAtPlayhead = useCallback(() => {
    const start = Math.min(playhead, Math.max(0, durationSec - TARGET_MAX_SEC));
    const seg = clampSegment({ startSec: start, endSec: start + TARGET_MAX_SEC }, durationSec);
    onChange([...segments, seg].sort((a, b) => a.startSec - b.startSec));
    setSelected(segments.length);
  }, [playhead, durationSec, segments, onChange]);

  const removeAt = useCallback(
    (i: number) => {
      onChange(segments.filter((_, j) => j !== i));
      setSelected(null);
    },
    [segments, onChange],
  );

  // ── Dragging ──
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      noSnapRef.current = e.altKey;
      const raw = secAtClientX(e.clientX);
      const snapped = snapTo(raw, sceneCuts, !noSnapRef.current);
      const seg = segments[drag.index];
      if (!seg) return;

      if (drag.kind === "start") {
        update(drag.index, { ...seg, startSec: Math.min(snapped, seg.endSec - MIN_SEGMENT_SEC) });
      } else if (drag.kind === "end") {
        update(drag.index, { ...seg, endSec: Math.max(snapped, seg.startSec + MIN_SEGMENT_SEC) });
      } else {
        // Move the whole window, preserving its length.
        const len = seg.endSec - seg.startSec;
        const start = Math.max(0, Math.min(durationSec - len, raw - drag.grabOffset));
        const snappedStart = snapTo(start, sceneCuts, !noSnapRef.current);
        update(drag.index, { startSec: snappedStart, endSec: snappedStart + len });
      }
    };
    // Re-sort on release, not during: reordering mid-drag would yank the
    // handle out from under the cursor. Selection follows the segment it
    // was on, so the numbering stays honest after a drag past a neighbour.
    const onUp = () => {
      const moved = segments[drag.index];
      const sorted = [...segments].sort((a, b) => a.startSec - b.startSec);
      const changed = sorted.some((s, i) => s !== segments[i]);
      if (changed) {
        onChange(sorted);
        setSelected(moved ? sorted.indexOf(moved) : null);
      }
      setDrag(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, segments, sceneCuts, secAtClientX, update, durationSec, onChange]);

  // ── Keyboard ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const v = videoRef.current;

      if (e.key === " ") {
        e.preventDefault();
        if (v?.paused) void v.play();
        else v?.pause();
        return;
      }
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        addAtPlayhead();
        return;
      }
      if ((e.key === "i" || e.key === "I") && selected !== null) {
        e.preventDefault();
        const seg = segments[selected];
        if (seg) update(selected, { ...seg, startSec: Math.min(playhead, seg.endSec - MIN_SEGMENT_SEC) });
        return;
      }
      if ((e.key === "o" || e.key === "O") && selected !== null) {
        e.preventDefault();
        const seg = segments[selected];
        if (seg) update(selected, { ...seg, endSec: Math.max(playhead, seg.startSec + MIN_SEGMENT_SEC) });
        return;
      }
      if ((e.key === "Backspace" || e.key === "Delete") && selected !== null) {
        e.preventDefault();
        removeAt(selected);
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 0.1;
        seek(Math.max(0, Math.min(durationSec, playhead + (e.key === "ArrowLeft" ? -step : step))));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [segments, selected, playhead, durationSec, addAtPlayhead, removeAt, seek, update]);

  const totalKept = segments.reduce((s, x) => s + (x.endSec - x.startSec), 0);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start gap-3">
        <video
          ref={videoRef}
          src={previewUrl ?? undefined}
          controls
          muted
          playsInline
          onTimeUpdate={(e) => setPlayhead(e.currentTarget.currentTime)}
          className="aspect-[9/16] w-44 shrink-0 rounded bg-black object-cover"
        />

        <div className="min-w-[280px] flex-1 space-y-2">
          {/* Timeline */}
          <div
            ref={trackRef}
            className="relative h-16 w-full cursor-pointer select-none overflow-hidden rounded border bg-muted bg-cover bg-center"
            style={filmstripUrl ? { backgroundImage: `url(${filmstripUrl})`, backgroundSize: "100% 100%" } : undefined}
            onMouseDown={(e) => {
              // Clicking empty track scrubs; segments stop propagation.
              if (e.target === trackRef.current) seek(secAtClientX(e.clientX));
            }}
          >
            {/* Scene cuts — the snap targets */}
            {sceneCuts.map((c, i) => (
              <div
                key={`cut-${i}`}
                className="pointer-events-none absolute top-0 h-full w-px bg-white/70 mix-blend-difference"
                style={{ left: `${pctOf(c)}%` }}
                title={`Scene change at ${c.toFixed(1)}s`}
              />
            ))}

            {/* Segments */}
            {segments.map((s, i) => {
              const len = s.endSec - s.startSec;
              const tone = segmentTone(len);
              return (
                <div
                  key={`seg-${i}`}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    setSelected(i);
                    setDrag({ kind: "move", index: i, grabOffset: secAtClientX(e.clientX) - s.startSec });
                  }}
                  className={`absolute top-1 flex h-14 items-center justify-center rounded border-2 ${TONE_CLASS[tone]} ${
                    selected === i ? "ring-2 ring-primary ring-offset-1" : ""
                  } ${disabled ? "" : "cursor-grab active:cursor-grabbing"}`}
                  style={{ left: `${pctOf(s.startSec)}%`, width: `${Math.max(1, pctOf(len))}%` }}
                  title={`${s.startSec.toFixed(1)}s → ${s.endSec.toFixed(1)}s (${len.toFixed(1)}s)`}
                >
                  {/* Chip, not bare text — the filmstrip behind is busy. */}
                  <span className="pointer-events-none rounded bg-background/85 px-1 text-[10px] font-semibold tabular-nums shadow-sm">
                    {i + 1} · {len.toFixed(1)}s
                  </span>
                  {/* Edge handles */}
                  <span
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      setSelected(i);
                      setDrag({ kind: "start", index: i });
                    }}
                    className="absolute left-0 top-0 h-full w-2 cursor-ew-resize rounded-l bg-foreground/20 hover:bg-foreground/40"
                  />
                  <span
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      setSelected(i);
                      setDrag({ kind: "end", index: i });
                    }}
                    className="absolute right-0 top-0 h-full w-2 cursor-ew-resize rounded-r bg-foreground/20 hover:bg-foreground/40"
                  />
                </div>
              );
            })}

            {/* Playhead */}
            <div
              className="pointer-events-none absolute top-0 h-full w-0.5 bg-primary"
              style={{ left: `${pctOf(playhead)}%` }}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {playhead.toFixed(1)}s / {durationSec.toFixed(1)}s
            </span>
            <span>·</span>
            <span>
              {segments.length} segment{segments.length === 1 ? "" : "s"} · {totalKept.toFixed(1)}s kept
            </span>
            <div className="flex-1" />
            <Button variant="outline" size="sm" onClick={addAtPlayhead} disabled={disabled}>
              <Plus className="h-4 w-4 mr-1" /> Segment at playhead
            </Button>
            {onSuggest && (
              <Button variant="outline" size="sm" onClick={onSuggest} disabled={disabled || suggesting}>
                {suggesting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Wand2 className="h-4 w-4 mr-1" />}
                Re-suggest
              </Button>
            )}
          </div>

          {/* Per-segment rows — precise editing + the numbers */}
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {segments.map((s, i) => {
              const len = s.endSec - s.startSec;
              const tone = segmentTone(len);
              return (
                <div
                  key={`row-${i}`}
                  onClick={() => setSelected(i)}
                  className={`flex items-center gap-2 rounded border px-2 py-1 text-xs ${
                    selected === i ? "border-primary bg-muted/60" : ""
                  }`}
                >
                  <span className="w-4 font-semibold tabular-nums">{i + 1}</span>
                  <button className="tabular-nums hover:underline" onClick={() => seek(s.startSec)} title="Jump here">
                    {s.startSec.toFixed(1)}s
                  </button>
                  <span>→</span>
                  <button className="tabular-nums hover:underline" onClick={() => seek(s.endSec)} title="Jump here">
                    {s.endSec.toFixed(1)}s
                  </button>
                  <Badge
                    variant={tone === "good" ? "secondary" : "outline"}
                    className={tone === "bad" ? "text-red-600" : tone === "warn" ? "text-amber-600" : ""}
                  >
                    {len.toFixed(1)}s
                  </Badge>
                  {tone === "warn" && <span className="text-amber-600">long for one beat</span>}
                  {tone === "bad" && <span className="text-red-600">under {MIN_SEGMENT_SEC}s — won&apos;t cut</span>}
                  <div className="flex-1" />
                  <Button variant="ghost" size="icon-xs" onClick={() => removeAt(i)} disabled={disabled} title="Remove segment">
                    <Trash2 />
                  </Button>
                </div>
              );
            })}
            {segments.length === 0 && (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                No segments — press <b>N</b> or use “Segment at playhead” to add one.
              </p>
            )}
          </div>

          <p className="text-[11px] text-muted-foreground">
            <Scissors className="mr-1 inline h-3 w-3" />
            <b>space</b> play · <b>N</b> new segment · <b>I</b>/<b>O</b> set in/out at playhead · <b>←/→</b> nudge
            (shift = 1s) · <b>⌫</b> delete · drag snaps to scene changes (hold <b>alt</b> to ignore)
          </p>
        </div>
      </div>
    </div>
  );
}
