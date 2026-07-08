/**
 * Post rendering — concat normalized clips into a finished 9:16 video.
 *
 * Because every input comes from the same normalization profile
 * (normalize.ts), the concat demuxer can stream-copy: renders take
 * seconds and cost no quality. Per clip we pick either the audible
 * (normalized) or muted variant according to the composer's resolved
 * audio plan. If every segment is muted we drop the audio track
 * entirely (`-an`) — trending audio gets added in the TikTok app.
 *
 * Renders write to tmp/ first, get ffprobe-validated, then rename()
 * atomically into renders/{YYYY-MM}/. Idempotent: an existing valid
 * output short-circuits the whole render (at-least-once job queue).
 */
import { eq, sql } from "drizzle-orm";
import { writeFile, unlink } from "fs/promises";
import { db } from "@/lib/db";
import { videoClips, videoPosts, type VideoClip } from "@/modules/marketing/schema";
import {
  materializeVideo,
  storeVideoFile,
  videoScratchPath,
  videoStat,
  renderPath,
} from "@/lib/storage/videos";
import { runFfmpeg, ffprobe } from "./ffmpeg";
import { NORM_VERSION } from "./normalize";

/** Renders bigger than this are almost certainly a bug (30s @ ~12MB typical). */
const SIZE_WARN_BYTES = 50 * 1024 * 1024;

export interface RenderResult {
  postId: string;
  filePath: string;
  posterPath: string;
  durationSec: number;
  sizeBytes: number;
  skipped: boolean;
  reencoded: boolean;
}

function yyyymmOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Escape a path for the concat demuxer list format (file '...'). */
function concatEntry(fullPath: string): string {
  return `file '${fullPath.replace(/'/g, "'\\''")}'`;
}

export async function renderPost(postId: string): Promise<RenderResult> {
  const post = db.select().from(videoPosts).where(eq(videoPosts.id, postId)).get();
  if (!post) throw new Error(`Post not found: ${postId}`);
  if (post.status === "discarded") throw new Error(`Post ${postId} is discarded`);

  const clipIds = JSON.parse(post.clipIds) as string[];
  const audibleIds = new Set(JSON.parse(post.audibleClipIds || "[]") as string[]);

  // ── Idempotency: existing valid output short-circuits ──
  if (post.filePath) {
    const existing = await videoStat(post.filePath);
    if (existing.exists) {
      try {
        const m = await materializeVideo(post.filePath);
        try {
          const probe = await ffprobe(m.path);
          if (probe.durationSec > 0) {
            return {
              postId,
              filePath: post.filePath,
              posterPath: post.posterPath ?? "",
              durationSec: probe.durationSec,
              sizeBytes: existing.size,
              skipped: true,
              reencoded: false,
            };
          }
        } finally {
          await m.cleanup();
        }
      } catch {
        // fall through and re-render over the broken file
      }
    }
  }

  db.update(videoPosts)
    .set({ status: "rendering", error: null, updatedAt: new Date().toISOString() })
    .where(eq(videoPosts.id, postId))
    .run();

  // Temp files (materialized clip inputs + concat list + render/poster
  // scratch) cleaned up regardless of outcome. storeVideoFile pushes the
  // finished render + poster to storage (R2 or the volume).
  const cleanups: Array<() => Promise<void>> = [];
  const scratch = (name: string) => {
    const p = videoScratchPath(name);
    cleanups.push(() => unlink(p).catch(() => {}));
    return p;
  };

  try {
    // ── Load + validate clips ──
    const clipsById = new Map<string, VideoClip>();
    for (const id of clipIds) {
      const clip = db.select().from(videoClips).where(eq(videoClips.id, id)).get();
      if (!clip) throw new Error(`Clip ${id} not found`);
      if (clip.status !== "ready" || !clip.normalizedPath || !clip.mutedPath) {
        throw new Error(`Clip ${id} (${clip.fileName}) is not ready (status=${clip.status})`);
      }
      if (clip.normVersion !== NORM_VERSION) {
        // Mixed normalization profiles can't be stream-copy concated.
        throw new Error(
          `Clip ${id} normalized at v${clip.normVersion}, expected v${NORM_VERSION} — renormalize it first`,
        );
      }
      clipsById.set(id, clip);
    }

    // Pull each segment (audible or muted variant) to local disk for the
    // concat demuxer. Materialize is a no-op copy on the volume; a download
    // on R2. Runs sequentially so the concat list order is deterministic.
    const sources: string[] = [];
    for (const id of clipIds) {
      const clip = clipsById.get(id)!;
      const useOriginalAudio = audibleIds.has(id) && clip.audioMode === "keep";
      const m = await materializeVideo(useOriginalAudio ? clip.normalizedPath! : clip.mutedPath!);
      cleanups.push(m.cleanup);
      sources.push(m.path);
    }
    const fullySilent = clipIds.every(
      (id) => !(audibleIds.has(id) && clipsById.get(id)!.audioMode === "keep"),
    );
    const expectedDuration = clipIds.reduce(
      (sum, id) => sum + (clipsById.get(id)!.durationSec ?? 0),
      0,
    );

    // ── Concat in scratch temps ──
    const listFull = scratch(`${postId}.txt`);
    const outTmpFull = scratch(`${postId}.mp4`);
    await writeFile(listFull, sources.map(concatEntry).join("\n") + "\n");

    const concatArgs = (audio: string[]) => [
      "-y",
      "-f", "concat", "-safe", "0",
      "-i", listFull,
      "-c:v", "copy",
      ...audio,
      "-movflags", "+faststart",
      outTmpFull,
    ];

    let reencoded = false;
    await runFfmpeg(concatArgs(fullySilent ? ["-an"] : ["-c:a", "copy"]));

    // ── Validate; on drift fall back to a one-shot re-encode ──
    let probe = await ffprobe(outTmpFull);
    const durationOk = Math.abs(probe.durationSec - expectedDuration) <= 1.0;
    if (!durationOk || probe.width !== 1080 || probe.height !== 1920) {
      console.warn(
        `[video] stream-copy concat validation failed for post ${postId} ` +
        `(got ${probe.width}x${probe.height} ${probe.durationSec}s, expected 1080x1920 ~${expectedDuration.toFixed(1)}s) — re-encoding`,
      );
      reencoded = true;
      await runFfmpeg([
        "-y",
        "-f", "concat", "-safe", "0",
        "-i", listFull,
        "-vf", "fps=30,setsar=1",
        "-c:v", "libx264", "-profile:v", "high", "-level", "4.1",
        "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
        ...(fullySilent ? ["-an"] : ["-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k"]),
        "-movflags", "+faststart",
        outTmpFull,
      ]);
      probe = await ffprobe(outTmpFull);
    }
    if (probe.sizeBytes > SIZE_WARN_BYTES) {
      console.warn(`[video] render for post ${postId} is unusually large: ${probe.sizeBytes} bytes`);
    }

    // ── Store into renders/{YYYY-MM}/ (R2 or the volume) ──
    const yyyymm = yyyymmOf(new Date());
    const fileRel = renderPath(postId, yyyymm, "mp4");
    const posterRel = renderPath(postId, yyyymm, "jpg");

    // Poster is cut from the finished render we already have on local disk,
    // then both are pushed to storage.
    const posterTmp = scratch(`${postId}-poster.jpg`);
    await runFfmpeg(["-y", "-i", outTmpFull, "-frames:v", "1", "-q:v", "3", posterTmp]);
    await storeVideoFile(outTmpFull, fileRel);
    await storeVideoFile(posterTmp, posterRel);

    // ── Persist. Guard the usage counters behind the status flip so a
    // retry that re-runs a completed render can't double-bump. ──
    const current = db.select({ status: videoPosts.status }).from(videoPosts)
      .where(eq(videoPosts.id, postId)).get();
    const firstCompletion = current?.status === "rendering";

    db.update(videoPosts)
      .set({
        status: "rendered",
        filePath: fileRel,
        posterPath: posterRel,
        durationSec: probe.durationSec,
        sizeBytes: probe.sizeBytes,
        error: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(videoPosts.id, postId))
      .run();

    if (firstCompletion) {
      const today = new Date().toISOString().slice(0, 10);
      for (const id of clipIds) {
        db.update(videoClips)
          .set({ timesUsed: sql`${videoClips.timesUsed} + 1`, lastUsedAt: today })
          .where(eq(videoClips.id, id))
          .run();
      }
    }

    return {
      postId,
      filePath: fileRel,
      posterPath: posterRel,
      durationSec: probe.durationSec,
      sizeBytes: probe.sizeBytes,
      skipped: false,
      reencoded,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    db.update(videoPosts)
      .set({ status: "failed", error: message.slice(0, 2000), updatedAt: new Date().toISOString() })
      .where(eq(videoPosts.id, postId))
      .run();
    throw e;
  } finally {
    for (const c of cleanups) await c();
  }
}
