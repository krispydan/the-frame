/**
 * Clip normalization — runs ONCE per uploaded clip (cached forever).
 *
 * Every clip is transcoded to one canonical profile so that post
 * renders can concat with pure stream copy (no re-encode):
 *   1080x1920 (cover-crop), 30fps, H.264 high@4.1 CRF 20, yuv420p,
 *   AAC 44.1kHz stereo 128k, +faststart, shared track timescale.
 *
 * Clips with no audio stream get a silent AAC track injected — every
 * normalized file MUST carry an identical audio stream layout or the
 * concat demuxer refuses to stream-copy.
 *
 * NORM_VERSION pins the profile. If these flags ever change, bump it —
 * mixed-version concat is forbidden (see render.ts).
 */
import { unlink } from "fs/promises";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { videoClips } from "@/modules/marketing/schema";
import {
  materializeVideo,
  storeVideoFile,
  videoScratchPath,
  videoStat,
  normalizedClipPath,
  mutedClipPath,
  clipPosterPath,
} from "@/lib/storage/videos";
import { runFfmpeg, ffprobe } from "./ffmpeg";

export const NORM_VERSION = 1;

const ENCODE_FLAGS = [
  "-c:v", "libx264",
  "-profile:v", "high",
  "-level", "4.1",
  "-preset", "medium",
  "-crf", "20",
  "-pix_fmt", "yuv420p",
  "-video_track_timescale", "15360",
];

const AUDIO_FLAGS = ["-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k"];

const SCALE_FILTER =
  "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1";

/**
 * Normalize one clip: canonical mp4 + muted variant + poster jpg.
 * Idempotent — skips any artifact that already exists on disk at the
 * current NORM_VERSION (safe under the job queue's at-least-once
 * delivery). Updates the clip row to status=ready on success.
 */
export async function normalizeClip(clipId: string): Promise<{
  clipId: string;
  skipped: boolean;
  durationSec: number;
}> {
  const clip = db.select().from(videoClips).where(eq(videoClips.id, clipId)).get();
  if (!clip) throw new Error(`Clip not found: ${clipId}`);
  if (clip.status === "archived") return { clipId, skipped: true, durationSec: clip.durationSec ?? 0 };

  const normRel = normalizedClipPath(clip.checksum, NORM_VERSION);
  const mutedRel = mutedClipPath(clip.checksum, NORM_VERSION);
  const posterRel = clipPosterPath(clip.checksum);

  const [normStat, mutedStat, posterStat] = await Promise.all([
    videoStat(normRel),
    videoStat(mutedRel),
    videoStat(posterRel),
  ]);
  const allExist = normStat.exists && mutedStat.exists && posterStat.exists;

  db.update(videoClips)
    .set({ status: "normalizing", error: null, updatedAt: new Date().toISOString() })
    .where(eq(videoClips.id, clipId))
    .run();

  // Temp files to clean up regardless of outcome (materialized inputs +
  // ffmpeg scratch outputs). storeVideoFile pushes each output to storage
  // (R2 or the volume) — nothing is left on local disk beyond these temps.
  const cleanups: Array<() => Promise<void>> = [];
  const scratch = (name: string) => {
    const p = videoScratchPath(name);
    cleanups.push(() => unlink(p).catch(() => {}));
    return p;
  };

  try {
    // The normalized file is the input for the muted + poster steps and the
    // final probe, so we need it on local disk throughout: freshly encoded,
    // or pulled back from storage. A freshly-encoded one is pushed to storage
    // LAST (storeVideoFile consumes the temp), after all readers are done.
    // The raw source is only fetched when a re-encode is actually needed.
    let normLocal: string;
    let normIsFresh = false;
    if (normStat.exists) {
      const m = await materializeVideo(normRel);
      cleanups.push(m.cleanup);
      normLocal = m.path;
    } else {
      const raw = await materializeVideo(clip.rawPath);
      cleanups.push(raw.cleanup);
      const rawProbe = await ffprobe(raw.path);
      normLocal = scratch(`${clip.checksum}_norm.mp4`);
      normIsFresh = true;
      const inputArgs = rawProbe.hasAudio
        ? ["-i", raw.path]
        : // Inject a silent stereo track so every normalized clip has an
          // identical audio layout (required for stream-copy concat).
          ["-i", raw.path, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-shortest", "-map", "0:v", "-map", "1:a"];
      await runFfmpeg([
        "-y",
        ...inputArgs,
        "-vf", SCALE_FILTER,
        ...ENCODE_FLAGS,
        ...AUDIO_FLAGS,
        "-movflags", "+faststart",
        normLocal,
      ]);
    }

    // ── Muted variant (video stream-copied, silent AAC) ──
    if (!mutedStat.exists) {
      const mutedLocal = scratch(`${clip.checksum}_muted.mp4`);
      await runFfmpeg([
        "-y",
        "-i", normLocal,
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
        "-map", "0:v", "-map", "1:a",
        "-c:v", "copy",
        ...AUDIO_FLAGS,
        "-shortest",
        "-movflags", "+faststart",
        mutedLocal,
      ]);
      await storeVideoFile(mutedLocal, mutedRel);
    }

    // ── Poster frame ──
    if (!posterStat.exists) {
      const posterLocal = scratch(`${clip.checksum}_poster.jpg`);
      await runFfmpeg(["-y", "-ss", "0.5", "-i", normLocal, "-frames:v", "1", "-q:v", "3", posterLocal]);
      await storeVideoFile(posterLocal, posterRel);
    }

    // Probe the normalized output — its duration is what concat math uses.
    const normProbe = await ffprobe(normLocal);

    // Push the normalized file last, once every reader above is done with it.
    if (normIsFresh) await storeVideoFile(normLocal, normRel);

    db.update(videoClips)
      .set({
        normalizedPath: normRel,
        mutedPath: mutedRel,
        posterPath: posterRel,
        durationSec: normProbe.durationSec,
        width: normProbe.width,
        height: normProbe.height,
        normVersion: NORM_VERSION,
        status: "ready",
        error: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(videoClips.id, clipId))
      .run();

    return { clipId, skipped: allExist, durationSec: normProbe.durationSec };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    db.update(videoClips)
      .set({ status: "failed", error: message.slice(0, 2000), updatedAt: new Date().toISOString() })
      .where(eq(videoClips.id, clipId))
      .run();
    throw e;
  } finally {
    for (const c of cleanups) await c();
  }
}
