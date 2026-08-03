/**
 * Split review — triaging clips that are too long to use as-is.
 *
 * A clip uploaded whole (auto-clip off, or from before it was the
 * default) can be 20-60s. The composer wants 3-5s beats and the retention
 * linter flags anything static past MAX_STATIC_CLIP_SEC, so those long
 * clips are dead weight until a human carves the usable moments out.
 *
 * This is the queue side of that job. The cutting itself is trimClip(),
 * which already inherits the parent's tags and dedupes by checksum — so
 * all that's needed here is: find them, remember which have been dealt
 * with, and propose where the cuts should go.
 *
 * Proposing matters more than it sounds. Drawing segments on a blank
 * timeline is slow; adjusting pre-placed ones is fast. The proposals come
 * from the SAME scene detector the auto-clipper uses, so a reviewer is
 * correcting a decent first guess rather than starting cold.
 */
import { db, sqlite } from "@/lib/db";
import { videoClips } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { materializeVideo } from "@/lib/storage/videos";
import { detectScenes, planWindows } from "./split";

/** Clips at or over this default to "worth a look". */
export const LONG_CLIP_SEC = 10;

/** The composer's sweet spot — proposals aim here. */
export const TARGET_MIN_SEC = 3;
export const TARGET_MAX_SEC = 5;

/** Matches trim.ts's MIN_TRIM_SEC — rejected there anyway, but catching
 *  it in the UI beats queueing six cuts to have one fail. */
export const MIN_SEGMENT_SEC = 1;

export interface ProposedSegment {
  startSec: number;
  endSec: number;
}

export interface SplitSuggestion {
  clipId: string;
  durationSec: number;
  /** Raw ffmpeg scene-change timestamps — the timeline snaps to these. */
  sceneCuts: number[];
  /** Pre-placed segments for the reviewer to adjust, not draw. */
  segments: ProposedSegment[];
  /** True when the cuts came from cache rather than a fresh ffmpeg pass. */
  cached: boolean;
}

interface ClipRow {
  id: string;
  durationSec: number | null;
  normalizedPath: string | null;
  rawPath: string | null;
  sceneCutsJson: string | null;
}

function loadClip(clipId: string): ClipRow {
  const row = db
    .select({
      id: videoClips.id,
      durationSec: videoClips.durationSec,
      normalizedPath: videoClips.normalizedPath,
      rawPath: videoClips.rawPath,
      sceneCutsJson: videoClips.sceneCutsJson,
    })
    .from(videoClips)
    .where(eq(videoClips.id, clipId))
    .get();
  if (!row) throw new Error("Clip not found");
  return row;
}

/**
 * Scene cuts for a clip, detected once and cached on the row.
 *
 * Detection is a full ffmpeg pass over the clip — a second or two, but
 * enough that re-running it every time the reviewer opens or reopens a
 * clip would be felt. `force` re-runs it anyway.
 */
export async function sceneCutsFor(clipId: string, force = false): Promise<{ cuts: number[]; cached: boolean }> {
  const clip = loadClip(clipId);

  if (!force && clip.sceneCutsJson) {
    try {
      const parsed = JSON.parse(clip.sceneCutsJson) as unknown;
      if (Array.isArray(parsed)) return { cuts: parsed.map(Number).filter(Number.isFinite), cached: true };
    } catch {
      /* corrupt cache — fall through and re-detect */
    }
  }

  const srcRel = clip.normalizedPath || clip.rawPath;
  if (!srcRel) throw new Error("Clip has no video file");

  const src = await materializeVideo(srcRel);
  let cuts: number[];
  try {
    cuts = await detectScenes(src.path);
  } finally {
    await src.cleanup();
  }

  sqlite
    .prepare(`UPDATE marketing_video_clips SET scene_cuts_json = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(cuts), clipId);

  return { cuts, cached: false };
}

/**
 * What to cut out of a long clip: scene cuts plus pre-placed segments.
 *
 * planWindows() is the auto-clipper's planner, reused so the proposal
 * here and an automatic split agree. If it comes back empty (a clip with
 * no detectable scene changes, which is common for one continuous shot),
 * fall back to evenly-spaced windows — an even split is still far better
 * to adjust than an empty timeline.
 */
export async function suggestSplit(clipId: string, force = false): Promise<SplitSuggestion> {
  const clip = loadClip(clipId);
  const duration = clip.durationSec ?? 0;
  if (duration <= 0) throw new Error("Clip has no known duration yet — it may still be processing");

  const { cuts, cached } = await sceneCutsFor(clipId, force);

  let segments: ProposedSegment[] = planWindows(cuts, duration, {
    minLen: TARGET_MIN_SEC,
    maxLen: TARGET_MAX_SEC,
  }).map((w) => ({
    startSec: round1(w.start),
    endSec: round1(w.start + w.duration),
  }));

  if (segments.length === 0) segments = evenWindows(duration);

  return { clipId, durationSec: duration, sceneCuts: cuts, segments, cached };
}

/** Evenly-spaced target-length windows — the no-scene-changes fallback. */
export function evenWindows(duration: number, target = TARGET_MAX_SEC): ProposedSegment[] {
  if (!(duration > 0)) return [];
  const n = Math.max(1, Math.floor(duration / target));
  const len = duration / n;
  if (len < TARGET_MIN_SEC) return [{ startSec: 0, endSec: round1(duration) }];
  return Array.from({ length: n }, (_, i) => ({
    startSec: round1(i * len),
    endSec: round1(Math.min(duration, (i + 1) * len)),
  }));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ── Queue bookkeeping ──

export interface ReviewQueueStats {
  pending: number;
  reviewed: number;
  longestSec: number;
  /** Total seconds sitting in clips too long to use as-is. */
  pendingSec: number;
}

export function reviewQueueStats(minSec = LONG_CLIP_SEC): ReviewQueueStats {
  const row = sqlite
    .prepare(
      `SELECT
         SUM(split_reviewed_at IS NULL)     AS pending,
         SUM(split_reviewed_at IS NOT NULL) AS reviewed,
         COALESCE(MAX(duration_sec), 0)     AS longestSec,
         COALESCE(SUM(CASE WHEN split_reviewed_at IS NULL THEN duration_sec ELSE 0 END), 0) AS pendingSec
       FROM marketing_video_clips
      WHERE status = 'ready' AND duration_sec IS NOT NULL AND duration_sec >= ?`,
    )
    .get(minSec) as { pending: number | null; reviewed: number | null; longestSec: number; pendingSec: number };

  return {
    pending: row.pending ?? 0,
    reviewed: row.reviewed ?? 0,
    longestSec: Math.round((row.longestSec ?? 0) * 10) / 10,
    pendingSec: Math.round(row.pendingSec ?? 0),
  };
}

/** Mark reviewed (split or deliberately left alone). Idempotent. */
export function markReviewed(clipIds: string[]): number {
  if (clipIds.length === 0) return 0;
  const stmt = sqlite.prepare(
    `UPDATE marketing_video_clips
        SET split_reviewed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND split_reviewed_at IS NULL`,
  );
  let n = 0;
  for (const id of clipIds) n += stmt.run(id).changes;
  return n;
}

/** Put a clip back in the queue. */
export function unmarkReviewed(clipId: string): void {
  sqlite
    .prepare(`UPDATE marketing_video_clips SET split_reviewed_at = NULL, updated_at = datetime('now') WHERE id = ?`)
    .run(clipId);
}

// ── Applying a split ──

export type ParentAction = "archive" | "keep";

export interface SplitOutcome {
  clipId: string;
  created: Array<{ id: string; fileName: string; durationSec: number | null; startSec: number; endSec: number }>;
  deduped: number;
  failed: Array<{ startSec: number; endSec: number; error: string }>;
  parentArchived: boolean;
}

/**
 * Cut every segment out of a clip.
 *
 * Runs in a job, not a request: each segment re-encodes AND normalizes,
 * so six segments can take the better part of a minute — past what a
 * serverless request should hold open.
 *
 * One bad segment doesn't sink the rest; failures are reported per
 * segment so the reviewer can see exactly which range was rejected.
 *
 * The parent is ARCHIVED, never deleted, once at least one child exists —
 * a rendered post may still reference it, and its file is the only source
 * for any future re-cut.
 */
export async function applySplit(
  clipId: string,
  segments: ProposedSegment[],
  parentAction: ParentAction = "archive",
): Promise<SplitOutcome> {
  const { trimClip } = await import("./trim");

  const created: SplitOutcome["created"] = [];
  const failed: SplitOutcome["failed"] = [];
  let deduped = 0;

  // In timeline order, so the generated file names read in sequence.
  const ordered = [...segments].sort((a, b) => a.startSec - b.startSec);

  for (const seg of ordered) {
    try {
      const r = await trimClip(clipId, seg.startSec, seg.endSec);
      if (r.deduped) deduped++;
      created.push({
        id: r.clip.id,
        fileName: r.clip.fileName,
        durationSec: r.clip.durationSec,
        startSec: seg.startSec,
        endSec: seg.endSec,
      });
    } catch (e) {
      failed.push({
        startSec: seg.startSec,
        endSec: seg.endSec,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Reviewed either way — the human has now looked at it.
  markReviewed([clipId]);

  let parentArchived = false;
  if (parentAction === "archive" && created.length > 0) {
    sqlite
      .prepare(`UPDATE marketing_video_clips SET status = 'archived', updated_at = datetime('now') WHERE id = ?`)
      .run(clipId);
    parentArchived = true;
  }

  return { clipId, created, deduped, failed, parentArchived };
}
