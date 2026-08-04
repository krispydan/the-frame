/**
 * Non-destructive clip trims.
 *
 * A trim used to mint a whole new clip: download the source, re-encode,
 * normalize (a second encode plus poster and muted variant), upload. Slow
 * enough to feel broken, occasionally slow enough to actually fail, and
 * one-way — once trimmed you could never widen the range back out,
 * because the trimmed clip was a new fixed asset.
 *
 * Now a trim is two numbers stored against the POSITION in a post's
 * sequence, applied when the video renders. Setting one is a database
 * write: instant, unfailable, free, and reversible.
 *
 * Stored index-parallel to clipIds rather than keyed by clip id, because
 * the same clip can legitimately appear twice in one sequence with
 * different in/out points — a keyed map cannot express that.
 *
 *   clipIds:   ["a",  "b",              "a"]
 *   clipTrims: [null, {in:1.0,out:3.5}, {in:0,out:2.0}]
 *
 * The library clip is never touched, so this does NOT replace trimClip():
 * the split-review queue still mints real clips, because those become
 * reusable library assets in their own right. This is for arranging one
 * video.
 */

/** Seconds into the source clip. `out` is exclusive. */
export interface ClipTrim {
  inSec: number;
  outSec: number;
}

/** Matches trim.ts — a sub-second beat is useless in a composition. */
export const MIN_TRIM_SEC = 1;

/**
 * Parse the stored JSON into an array aligned to `clipIds`.
 *
 * Any shape mismatch yields all-nulls rather than a partial guess: a
 * misaligned trim would silently cut the WRONG clip, which is worse than
 * losing the trim.
 */
export function parseClipTrims(json: string | null | undefined, clipCount: number): Array<ClipTrim | null> {
  const empty = new Array<ClipTrim | null>(clipCount).fill(null);
  if (!json) return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return empty;
  }
  if (!Array.isArray(parsed) || parsed.length !== clipCount) return empty;

  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object") return null;
    const rec = entry as Record<string, unknown>;
    const inSec = Number(rec.inSec);
    const outSec = Number(rec.outSec);
    if (!Number.isFinite(inSec) || !Number.isFinite(outSec)) return null;
    if (inSec < 0 || outSec <= inSec) return null;
    return { inSec, outSec };
  });
}

export function serializeClipTrims(trims: Array<ClipTrim | null>): string | null {
  // All-null is the common case — store NULL rather than "[null,null,…]".
  return trims.some(Boolean) ? JSON.stringify(trims) : null;
}

export interface TrimValidation {
  ok: boolean;
  error?: string;
  /** The trim clamped to the clip's real bounds. */
  trim?: ClipTrim;
}

/**
 * Check a trim against the clip it applies to.
 *
 * Clamped rather than rejected at the top end: durations are probed
 * floats, so a UI that lets you drag to "the end" can legitimately
 * produce an out point a few milliseconds past the probed duration.
 */
export function validateTrim(
  trim: { inSec: number; outSec: number },
  clipDurationSec: number | null,
): TrimValidation {
  const inSec = Number(trim.inSec);
  const outSec = Number(trim.outSec);

  if (!Number.isFinite(inSec) || !Number.isFinite(outSec)) {
    return { ok: false, error: "in/out must be numbers" };
  }
  if (inSec < 0) return { ok: false, error: "in point can't be negative" };
  if (outSec <= inSec) return { ok: false, error: "out point must be after the in point" };

  const duration = clipDurationSec ?? 0;
  // Checked BEFORE the length floor: an in point past the end also fails
  // the floor, and "must keep at least 1s" doesn't tell the operator that
  // the real problem is the handle being off the end of the clip.
  if (duration > 0 && inSec >= duration) {
    return { ok: false, error: `in point is past the clip's end (${duration.toFixed(1)}s)` };
  }
  const clampedOut = duration > 0 ? Math.min(outSec, duration) : outSec;
  if (clampedOut - inSec < MIN_TRIM_SEC) {
    return { ok: false, error: `A trimmed clip must keep at least ${MIN_TRIM_SEC}s` };
  }

  return { ok: true, trim: { inSec: round3(inSec), outSec: round3(clampedOut) } };
}

/** How long a clip contributes to the render, trimmed or not. */
export function effectiveDuration(clipDurationSec: number | null, trim: ClipTrim | null): number {
  const full = clipDurationSec ?? 0;
  if (!trim) return full;
  const out = full > 0 ? Math.min(trim.outSec, full) : trim.outSec;
  return Math.max(0, out - trim.inSec);
}

/**
 * A trim that covers the whole clip is not a trim — dropping it keeps the
 * render on the fast stream-copy path instead of re-encoding for nothing.
 */
export function isNoOpTrim(trim: ClipTrim | null, clipDurationSec: number | null): boolean {
  if (!trim) return true;
  const duration = clipDurationSec ?? 0;
  if (duration <= 0) return false;
  return trim.inSec <= 0.001 && trim.outSec >= duration - 0.001;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
