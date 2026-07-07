/**
 * Auto-clipper — turns raw shoot footage into 3-5s library clips.
 *
 * Pipeline per source:
 *   1. ffmpeg scene detection finds natural cut points (camera moves,
 *      new setup, new pose).
 *   2. planWindows() carves each scene into contiguous windows of
 *      slightly varied length (deterministic, so job retries plan the
 *      exact same cuts). Scene heads get a small trim so clips don't
 *      open on a transition frame.
 *   3. Each window is extracted (re-encode — stream copy can only cut
 *      on keyframes) and inserted as a normal marketing_video_clips
 *      row stamped with the source's default tags, then queued through
 *      the standard normalize pipeline.
 *
 * "Centering": clips inherit the pipeline's 9:16 center-crop. True
 * subject-tracking crop would need ML — review the library and archive
 * any clip the crop ruins.
 */
import { createHash } from "crypto";
import { readFile, unlink } from "fs/promises";
import { execFile } from "child_process";
import { eq } from "drizzle-orm";
import { db, sqlite } from "@/lib/db";
import { videoClips, videoSources } from "@/modules/marketing/schema";
import {
  ensureVideoDir,
  getVideoFullPath,
  rawClipPath,
  saveVideo,
  tmpPath,
} from "@/lib/storage/videos";
import { runFfmpeg, ffprobe } from "./ffmpeg";
import { jobQueue } from "@/modules/core/lib/job-queue";

// ── Scene detection ──

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
/** Scene-change score threshold. 0.3 is the ffmpeg folk default —
 *  catches hard cuts without firing on hand-held wobble. */
const SCENE_THRESHOLD = 0.3;

/**
 * Timestamps (seconds) where a new scene starts. Uses the select+
 * showinfo trick: decode only frames whose scene score exceeds the
 * threshold and parse their pts_time from showinfo's stderr output.
 */
export async function detectScenes(fullPath: string): Promise<number[]> {
  const stderr = await new Promise<string>((resolve, reject) => {
    execFile(
      FFMPEG,
      [
        "-hide_banner",
        "-i", fullPath,
        "-vf", `select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
        "-f", "null", "-",
      ],
      { timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 },
      (err, _stdout, stderrOut) => {
        // ffmpeg writes showinfo to stderr and exits 0 on success.
        if (err) reject(new Error(`scene detection failed: ${err.message}`));
        else resolve(String(stderrOut));
      },
    );
  });

  const times: number[] = [];
  const re = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;
  let match;
  while ((match = re.exec(stderr)) !== null) {
    times.push(parseFloat(match[1]));
  }
  return [...new Set(times)].sort((a, b) => a - b);
}

// ── Window planning (pure — unit tested) ──

export interface ClipWindow {
  start: number;
  duration: number;
}

export interface PlanOptions {
  minLen?: number;   // default 3
  maxLen?: number;   // default 5
  maxClips?: number; // default 40
  /** Skip this much of each scene head — avoids transition frames. */
  headTrim?: number; // default 0.2
}

/**
 * Carve [0, durationSec) into clip windows, respecting scene cuts.
 * Deterministic: window lengths cycle a fixed pattern between min and
 * max, so re-planning the same source yields identical cuts (safe for
 * at-least-once job retries).
 */
export function planWindows(
  sceneCuts: number[],
  durationSec: number,
  opts: PlanOptions = {},
): ClipWindow[] {
  const minLen = opts.minLen ?? 3;
  const maxLen = Math.max(opts.maxLen ?? 5, minLen);
  const maxClips = opts.maxClips ?? 40;
  const headTrim = opts.headTrim ?? 0.2;

  if (!(durationSec > 0) || minLen <= 0) return [];

  // Scene boundaries: start of video + cuts inside range + end.
  const cuts = sceneCuts.filter((t) => t > 0 && t < durationSec).sort((a, b) => a - b);
  const boundaries = [0, ...cuts, durationSec];

  // Deterministic varied lengths: cycle a fixed spread across [min,max].
  const spread = [0.5, 0.0, 1.0, 0.25, 0.75];
  const lengthFor = (i: number) => minLen + (maxLen - minLen) * spread[i % spread.length];

  const windows: ClipWindow[] = [];
  for (let b = 0; b < boundaries.length - 1 && windows.length < maxClips; b++) {
    const sceneStart = boundaries[b];
    const sceneEnd = boundaries[b + 1];

    // Trim the scene head when the scene can spare it.
    let pos = sceneStart;
    if (sceneEnd - sceneStart - headTrim >= minLen) pos += headTrim;

    while (windows.length < maxClips) {
      const remaining = sceneEnd - pos;
      if (remaining < minLen) break;
      // Don't leave an unusable tail: if taking the planned length
      // would strand < minLen, absorb the tail up to maxLen instead.
      let len = Math.min(lengthFor(windows.length), remaining);
      if (remaining - len < minLen && remaining <= maxLen) len = remaining;
      windows.push({ start: pos, duration: Math.round(len * 100) / 100 });
      pos += len;
    }
  }
  return windows;
}

// ── Split job ──

export interface SplitResult {
  sourceId: string;
  scenes: number;
  clipsCreated: number;
  clipsDeduped: number;
  skipped: boolean;
}

/**
 * Split one source into library clips. Idempotent: if the source is
 * already done (or clips from it already exist after a mid-run crash),
 * existing clips are kept and only missing windows are extracted —
 * dedupe is by extracted-bytes checksum, and window planning is
 * deterministic.
 */
export async function splitSource(sourceId: string): Promise<SplitResult> {
  const source = db.select().from(videoSources).where(eq(videoSources.id, sourceId)).get();
  if (!source) throw new Error(`Source not found: ${sourceId}`);
  if (source.status === "done") {
    return { sourceId, scenes: 0, clipsCreated: 0, clipsDeduped: 0, skipped: true };
  }

  db.update(videoSources)
    .set({ status: "splitting", error: null, updatedAt: new Date().toISOString() })
    .where(eq(videoSources.id, sourceId))
    .run();

  try {
    const fullPath = getVideoFullPath(source.rawPath);
    const probe = await ffprobe(fullPath);

    const scenes = await detectScenes(fullPath);
    const windows = planWindows(scenes, probe.durationSec, {
      minLen: source.minClipSec,
      maxLen: source.maxClipSec,
      maxClips: source.maxClips,
    });
    if (windows.length === 0) {
      throw new Error(
        `Video too short to clip (${probe.durationSec.toFixed(1)}s, min clip ${source.minClipSec}s)`,
      );
    }

    const skuIds = JSON.parse(source.skuIds || "[]") as string[];
    const insertProduct = sqlite.prepare(
      `INSERT OR IGNORE INTO marketing_video_clip_products (id, clip_id, sku_id) VALUES (?, ?, ?)`,
    );

    let created = 0;
    let deduped = 0;
    const baseName = source.fileName.replace(/\.[^.]+$/, "");

    for (const [i, window] of windows.entries()) {
      // Extract to tmp, hash, then content-address into clips/raw/.
      const tmpRel = tmpPath(`split-${sourceId}-${i}.mp4`);
      const tmpFull = await ensureVideoDir(tmpRel);
      await runFfmpeg([
        "-y",
        // Input-side seek: fast, and frame-accurate because we re-encode.
        "-ss", window.start.toFixed(3),
        "-i", fullPath,
        "-t", window.duration.toFixed(3),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "160k",
        "-movflags", "+faststart",
        tmpFull,
      ]);

      const bytes = await readFile(tmpFull);
      const checksum = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
      const rawRel = rawClipPath(checksum, "mp4");

      const existing = db.select({ id: videoClips.id }).from(videoClips)
        .where(eq(videoClips.checksum, checksum)).get();
      if (existing) {
        deduped++; // retry re-extracted an already-ingested window
        await unlink(tmpFull).catch(() => {});
        continue;
      }

      await saveVideo(bytes, rawRel);
      await unlink(tmpFull).catch(() => {});

      const clipId = crypto.randomUUID();
      db.insert(videoClips)
        .values({
          id: clipId,
          fileName: `${baseName}__${String(i + 1).padStart(2, "0")}.mp4`,
          checksum,
          rawPath: rawRel,
          sizeBytes: bytes.length,
          categoryId: source.categoryId,
          audioMode: source.audioMode,
          talent: source.talent,
          sourceId: source.id,
          status: "uploaded",
        })
        .run();
      for (const skuId of skuIds) insertProduct.run(crypto.randomUUID(), clipId, skuId);

      jobQueue.enqueue("marketing.video.normalize-clip", "marketing", { clipId }, { priority: 3 });
      created++;
    }

    const totalClips = (sqlite.prepare(
      `SELECT COUNT(*) AS n FROM marketing_video_clips WHERE source_id = ?`,
    ).get(sourceId) as { n: number }).n;

    db.update(videoSources)
      .set({
        status: "done",
        clipCount: totalClips,
        durationSec: probe.durationSec,
        width: probe.width,
        height: probe.height,
        error: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(videoSources.id, sourceId))
      .run();

    console.info(
      `[video] split ${source.fileName}: ${scenes.length} scene cuts → ${windows.length} windows, ` +
      `${created} clips created${deduped ? `, ${deduped} deduped` : ""}`,
    );
    return { sourceId, scenes: scenes.length, clipsCreated: created, clipsDeduped: deduped, skipped: false };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    db.update(videoSources)
      .set({ status: "failed", error: message.slice(0, 2000), updatedAt: new Date().toISOString() })
      .where(eq(videoSources.id, sourceId))
      .run();
    throw e;
  }
}
