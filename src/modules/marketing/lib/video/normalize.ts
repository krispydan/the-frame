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
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { videoClips } from "@/modules/marketing/schema";
import {
  getVideoFullPath,
  ensureVideoDir,
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

  try {
    const rawFull = getVideoFullPath(clip.rawPath);

    if (!allExist) {
      const rawProbe = await ffprobe(rawFull);

      // ── Canonical normalized file ──
      if (!normStat.exists) {
        const normFull = await ensureVideoDir(normRel);
        const inputArgs = rawProbe.hasAudio
          ? ["-i", rawFull]
          : // Inject a silent stereo track so every normalized clip has
            // an identical audio layout (required for stream-copy concat).
            ["-i", rawFull, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-shortest", "-map", "0:v", "-map", "1:a"];
        await runFfmpeg([
          "-y",
          ...inputArgs,
          "-vf", SCALE_FILTER,
          ...ENCODE_FLAGS,
          ...AUDIO_FLAGS,
          "-movflags", "+faststart",
          normFull,
        ]);
      }

      const normFull = getVideoFullPath(normRel);

      // ── Muted variant (video stream-copied, silent AAC) ──
      if (!mutedStat.exists) {
        const mutedFull = await ensureVideoDir(mutedRel);
        await runFfmpeg([
          "-y",
          "-i", normFull,
          "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
          "-map", "0:v", "-map", "1:a",
          "-c:v", "copy",
          ...AUDIO_FLAGS,
          "-shortest",
          "-movflags", "+faststart",
          mutedFull,
        ]);
      }

      // ── Poster frame ──
      if (!posterStat.exists) {
        const posterFull = await ensureVideoDir(posterRel);
        await runFfmpeg(["-y", "-ss", "0.5", "-i", normFull, "-frames:v", "1", "-q:v", "3", posterFull]);
      }
    }

    // Probe the normalized output — its duration is what concat math uses.
    const normProbe = await ffprobe(getVideoFullPath(normRel));

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
  }
}
