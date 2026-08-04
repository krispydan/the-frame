/**
 * Clip trimming — cut a clip to a new in/out point.
 *
 * Produces a NEW content-addressed clip (the original stays untouched —
 * other rendered posts may reference it) carrying over the parent's
 * category / talent / audio mode / product tags. The trimmed clip is
 * normalized SYNCHRONOUSLY so the caller gets back a ready clip it can
 * immediately swap into a post's sequence.
 *
 * The trim source is the clip's own video (normalized preferred — it's
 * the canonical 1080x1920@30). Trimming beyond the clip's bounds isn't
 * possible: the original shoot footage is deleted after auto-clipping.
 */
import { createHash } from "crypto";
import { readFile, unlink } from "fs/promises";
import { eq } from "drizzle-orm";
import { db, sqlite } from "@/lib/db";
import { videoClips, type VideoClip } from "@/modules/marketing/schema";
import { materializeVideo, videoScratchPath, rawClipPath, saveVideo } from "@/lib/storage/videos";
import { runFfmpeg, seekFriendlyFlags } from "./ffmpeg";
import { normalizeClip } from "./normalize";

export interface TrimResult {
  clip: VideoClip;
  /** True when this exact trim already existed (checksum match). */
  deduped: boolean;
}

/** Minimum trimmed length — anything shorter is useless in a composition. */
export const MIN_TRIM_SEC = 1;

/**
 * Cut `[startSec, endSec)` out of the clip into a new ready clip.
 * Throws on invalid ranges / missing media; never mutates the original.
 */
export async function trimClip(clipId: string, startSec: number, endSec: number): Promise<TrimResult> {
  const clip = db.select().from(videoClips).where(eq(videoClips.id, clipId)).get();
  if (!clip) throw new Error("Clip not found");

  const duration = clip.durationSec ?? 0;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) throw new Error("startSec and endSec are required");
  if (startSec < 0 || endSec <= startSec) throw new Error("endSec must be after startSec");
  if (endSec - startSec < MIN_TRIM_SEC) throw new Error(`Trimmed clip must be at least ${MIN_TRIM_SEC}s`);
  // Small tolerance: durations are probed floats.
  if (duration > 0 && endSec > duration + 0.25) throw new Error(`endSec is past the clip's end (${duration.toFixed(1)}s)`);

  const srcRel = clip.normalizedPath || clip.rawPath;
  if (!srcRel) throw new Error("Clip has no video file to trim");

  const src = await materializeVideo(srcRel);
  const tmpOut = videoScratchPath(`trim-${clipId}.mp4`);
  let bytes: Buffer;
  try {
    // Input-side seek: fast, and frame-accurate because we re-encode.
    // Same encoder settings as the auto-clipper so downstream normalize
    // treats trimmed clips identically.
    await runFfmpeg([
      "-y",
      "-ss", startSec.toFixed(3),
      "-i", src.path,
      "-t", (endSec - startSec).toFixed(3),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      ...seekFriendlyFlags(),
      "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "160k",
      "-movflags", "+faststart",
      tmpOut,
    ]);
    bytes = await readFile(tmpOut);
  } finally {
    await src.cleanup();
    await unlink(tmpOut).catch(() => {});
  }

  const checksum = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const existing = db.select().from(videoClips).where(eq(videoClips.checksum, checksum)).get();
  if (existing) return { clip: existing, deduped: true };

  const rawRel = rawClipPath(checksum, "mp4");
  await saveVideo(bytes, rawRel);

  const newId = crypto.randomUUID();
  const stem = clip.fileName.replace(/\.[^.]+$/, "");
  db.insert(videoClips)
    .values({
      id: newId,
      fileName: `${stem}__trim_${startSec.toFixed(1)}-${endSec.toFixed(1)}.mp4`,
      checksum,
      rawPath: rawRel,
      sizeBytes: bytes.length,
      categoryId: clip.categoryId,
      audioMode: clip.audioMode,
      talent: clip.talent,
      sourceId: clip.sourceId,
      status: "uploaded",
    })
    .run();

  // Carry the parent's product tags onto the trim.
  const insertTag = sqlite.prepare(
    `INSERT OR IGNORE INTO marketing_video_clip_products (id, clip_id, sku_id)
     SELECT ?, ?, sku_id FROM marketing_video_clip_products WHERE clip_id = ? AND sku_id = ?`,
  );
  const tags = sqlite
    .prepare(`SELECT sku_id AS skuId FROM marketing_video_clip_products WHERE clip_id = ?`)
    .all(clipId) as Array<{ skuId: string }>;
  for (const t of tags) insertTag.run(crypto.randomUUID(), newId, clipId, t.skuId);

  // Synchronous normalize → the caller gets a READY clip back.
  await normalizeClip(newId);

  const ready = db.select().from(videoClips).where(eq(videoClips.id, newId)).get();
  if (!ready) throw new Error("Trim vanished during normalize");
  return { clip: ready, deduped: false };
}
