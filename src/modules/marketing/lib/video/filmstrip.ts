/**
 * Filmstrip — a row of evenly-spaced thumbnails across a clip, rendered
 * as one wide JPEG to sit behind the splitter's timeline.
 *
 * One image rather than N: a 20-tile strip as separate requests is 20
 * round-trips and 20 <img> tags for something that is always shown as a
 * single contiguous band. ffmpeg's `fps` + `tile` filters produce it in
 * one pass.
 *
 * Deterministic for a given clip, so it's cached on the volume and only
 * built once.
 */
import { unlink, readFile } from "fs/promises";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { videoClips } from "@/modules/marketing/schema";
import { materializeVideo, videoScratchPath, saveVideo, videoStat, videoUrl } from "@/lib/storage/videos";
import { runFfmpeg } from "./ffmpeg";

/** Thumbnail height; width follows the source aspect. */
const TILE_H = 72;
/** Enough to read the shape of a clip without a huge image. */
const MAX_TILES = 24;
const MIN_TILES = 6;

export function filmstripPath(checksum: string): string {
  return `clips/filmstrips/${checksum}.jpg`;
}

/** Tile count scaled to length — a 12s clip doesn't need 24 frames. */
export function tileCountFor(durationSec: number): number {
  return Math.max(MIN_TILES, Math.min(MAX_TILES, Math.round(durationSec / 1.5)));
}

export async function buildFilmstrip(clipId: string): Promise<{ url: string; tiles: number }> {
  const clip = db.select().from(videoClips).where(eq(videoClips.id, clipId)).get();
  if (!clip) throw new Error("Clip not found");

  const duration = clip.durationSec ?? 0;
  if (!(duration > 0)) throw new Error("Clip has no known duration yet");

  const tiles = tileCountFor(duration);
  const rel = filmstripPath(clip.checksum);

  // Cached — a clip's frames never change.
  if ((await videoStat(rel)).exists) return { url: videoUrl(rel), tiles };

  const srcRel = clip.normalizedPath || clip.rawPath;
  if (!srcRel) throw new Error("Clip has no video file");

  const src = await materializeVideo(srcRel);
  const tmp = videoScratchPath(`filmstrip-${clip.checksum}.jpg`);
  try {
    // fps picks `tiles` frames spread across the clip; tile lays them out
    // in one row. -frames:v 1 keeps only the finished mosaic.
    const fps = tiles / duration;
    await runFfmpeg([
      "-y",
      "-i", src.path,
      "-vf", `fps=${fps.toFixed(6)},scale=-1:${TILE_H},tile=${tiles}x1`,
      "-frames:v", "1",
      "-q:v", "4",
      tmp,
    ]);
    await saveVideo(await readFile(tmp), rel);
  } finally {
    await src.cleanup();
    await unlink(tmp).catch(() => {});
  }

  return { url: videoUrl(rel), tiles };
}
