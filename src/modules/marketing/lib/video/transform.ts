/**
 * Clip transforms — derive a new clip from an existing one by applying a
 * visual effect. Same content-addressed, non-destructive pattern as
 * trim.ts: the original clip is never touched (other rendered posts may
 * reference it); the transformed clip is a NEW row, normalized
 * synchronously, returned READY so the caller can swap it into a post.
 *
 * Supported transforms:
 *   • reframe — crop tighter and scale back to full frame ("zoom in" to
 *     get a punchier composition). Focal point is chosen by the caller.
 *   • punch   — a slow Ken Burns push-in across the clip (adds motion to
 *     otherwise static product shots).
 *   • speed   — slow-mo (<1) or speed-up (>1), audio pitch-preserved.
 *
 * The transform output is written at the canonical 1080x1920, so the
 * subsequent normalize pass is effectively a re-mux to the canonical
 * profile (see normalize.ts) and downstream concat treats it identically.
 */
import { createHash } from "crypto";
import { readFile, unlink } from "fs/promises";
import { eq } from "drizzle-orm";
import { db, sqlite } from "@/lib/db";
import { videoClips, type VideoClip } from "@/modules/marketing/schema";
import { materializeVideo, videoScratchPath, rawClipPath, saveVideo } from "@/lib/storage/videos";
import { runFfmpeg, ffprobe, seekFriendlyFlags } from "./ffmpeg";
import { normalizeClip } from "./normalize";

export type ClipTransform =
  /** Zoom in by `zoom`× around normalized focal point (x,y ∈ 0..1). */
  | { kind: "reframe"; zoom: number; x: number; y: number }
  /** Slow Ken Burns push-in across the whole clip. */
  | { kind: "punch" }
  /** Playback speed: 0.5 = half-speed slow-mo, 2 = double-speed. */
  | { kind: "speed"; factor: number };

export interface TransformResult {
  clip: VideoClip;
  /** True when this exact transform already existed (checksum match). */
  deduped: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** A short, human-readable suffix + the ffmpeg args for a transform. */
function planTransform(t: ClipTransform, w: number, h: number): { suffix: string; args: string[] } {
  const enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", ...seekFriendlyFlags()];
  const tail = ["-movflags", "+faststart"];

  if (t.kind === "reframe") {
    const z = clamp(t.zoom, 1.05, 3);
    const cw = even(w / z);
    const ch = even(h / z);
    const cx = clamp(Math.round(clamp(t.x, 0, 1) * w - cw / 2), 0, w - cw);
    const cy = clamp(Math.round(clamp(t.y, 0, 1) * h - ch / 2), 0, h - ch);
    // Name carries the focal point too — two reframes of the same clip at
    // the same zoom but different positions are different shots, and
    // identical filenames make them indistinguishable in the library.
    const px = Math.round(clamp(t.x, 0, 1) * 100);
    const py = Math.round(clamp(t.y, 0, 1) * 100);
    return {
      suffix: `reframe_${z.toFixed(2)}_${px}x${py}`,
      args: ["-vf", `crop=${cw}:${ch}:${cx}:${cy},scale=${w}:${h},setsar=1`, ...enc, "-c:a", "copy", ...tail],
    };
  }

  if (t.kind === "punch") {
    // d=1 → each input frame processed once; `on` is the output frame index,
    // so zoom ramps smoothly from 1.0 to a gentle 1.12 cap across the clip.
    const vf =
      `zoompan=z='min(1.0+0.0009*on,1.12)':d=1:` +
      `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=30,setsar=1`;
    return { suffix: "punch", args: ["-vf", vf, ...enc, "-c:a", "copy", ...tail] };
  }

  // speed
  const f = clamp(t.factor, 0.5, 2);
  const pts = (1 / f).toFixed(4);
  return {
    suffix: `speed_${f.toFixed(2)}`,
    args: [
      "-filter_complex",
      `[0:v]setpts=${pts}*PTS[v];[0:a]atempo=${f}[a]`,
      "-map", "[v]", "-map", "[a]",
      ...enc, "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "160k", ...tail,
    ],
  };
}

/**
 * Apply `transform` to the clip, producing a new ready clip.
 * Throws on invalid params / missing media; never mutates the original.
 */
export async function transformClip(clipId: string, transform: ClipTransform): Promise<TransformResult> {
  const clip = db.select().from(videoClips).where(eq(videoClips.id, clipId)).get();
  if (!clip) throw new Error("Clip not found");

  if (transform.kind === "reframe" && !(transform.zoom > 1)) throw new Error("zoom must be greater than 1");
  if (transform.kind === "speed" && !(transform.factor > 0)) throw new Error("speed factor must be positive");

  const srcRel = clip.normalizedPath || clip.rawPath;
  if (!srcRel) throw new Error("Clip has no video file to transform");

  const src = await materializeVideo(srcRel);
  const tmpOut = videoScratchPath(`xform-${clipId}.mp4`);
  const stem = clip.fileName.replace(/\.[^.]+$/, "");
  let bytes: Buffer;
  let fxSuffix: string;
  try {
    const probe = await ffprobe(src.path);
    const w = probe.width || 1080;
    const h = probe.height || 1920;
    const { suffix, args } = planTransform(transform, w, h);
    await runFfmpeg(["-y", "-i", src.path, ...args, tmpOut]);
    bytes = await readFile(tmpOut);
    fxSuffix = suffix;
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
  db.insert(videoClips)
    .values({
      id: newId,
      fileName: `${stem}__${fxSuffix}.mp4`,
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

  // Carry the parent's product tags onto the transformed clip.
  const insertTag = sqlite.prepare(
    `INSERT OR IGNORE INTO marketing_video_clip_products (id, clip_id, sku_id)
     SELECT ?, ?, sku_id FROM marketing_video_clip_products WHERE clip_id = ? AND sku_id = ?`,
  );
  const tags = sqlite
    .prepare(`SELECT sku_id AS skuId FROM marketing_video_clip_products WHERE clip_id = ?`)
    .all(clipId) as Array<{ skuId: string }>;
  for (const t of tags) insertTag.run(crypto.randomUUID(), newId, clipId, t.skuId);

  await normalizeClip(newId);

  const ready = db.select().from(videoClips).where(eq(videoClips.id, newId)).get();
  if (!ready) throw new Error("Transform vanished during normalize");
  return { clip: ready, deduped: false };
}
