/**
 * Hook burn-in — bakes the video's hook line onto the first seconds of
 * the render as bold on-screen text. This is the motion half of the
 * vitality backbone: research is blunt that the first ~2 seconds decide
 * distribution and that on-screen text (viewers watch muted) is the
 * single biggest retention lever.
 *
 * Design: the clean concat render (`filePath`) is NEVER mutated. We
 * derive a SEPARATE burned file (`burnedPath`) from it and the serving
 * layer prefers the burned one. Re-burning always starts from the clean
 * render, so changing the hook never stacks text. A fresh render clears
 * the burned fields (see render.ts), so a stale burn is never served.
 *
 * Font is BUNDLED in the repo (assets/fonts) — the production container's
 * system fonts can't be trusted (that caused tofu boxes before), and the
 * repo's src/ tree is present at runtime (the prompt store reads from it).
 */
import path from "path";
import { writeFile, unlink } from "fs/promises";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { videoPosts } from "@/modules/marketing/schema";
import {
  materializeVideo,
  storeVideoFile,
  videoScratchPath,
  videoStat,
  deleteVideo,
} from "@/lib/storage/videos";
import { runFfmpeg, ffprobe } from "./ffmpeg";

const FONT = path.join(process.cwd(), "src", "modules", "marketing", "assets", "fonts", "HookText-Bold.ttf");

/** Seconds the hook stays on screen (muted viewers need time to read). */
const HOLD_SEC = 3.2;

export interface BurnResult {
  burned: boolean;
  skipped?: boolean;
  reason?: string;
  burnedPath?: string | null;
}

/** The burned variant path — co-located with the clean render (same
 *  directory + `_hook` suffix) so a re-burn overwrites in place and the
 *  file never orphans in a different month than its source. */
function burnedPathFor(cleanFilePath: string): string {
  return cleanFilePath.replace(/\.mp4$/i, "_hook.mp4");
}

/**
 * Word-wrap a hook into at most `maxLines` lines of ~`maxChars` each,
 * ellipsising anything that overflows. Returns the wrapped text (real
 * newlines) — written to a textfile so ffmpeg needs no escaping.
 */
export function wrapHook(raw: string, maxChars = 20, maxLines = 3): string {
  const words = raw.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines.join("\n");
  // Overflow: keep the first maxLines and ellipsise the last.
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = kept[maxLines - 1].slice(0, maxChars).trimEnd() + "…";
  return kept.join("\n");
}

/**
 * Burn the post's hook onto its render. Idempotent: re-burning the same
 * hook is a no-op; no hook / burn disabled clears any prior burn.
 */
export async function burnHookIntoRender(postId: string): Promise<BurnResult> {
  const post = db.select().from(videoPosts).where(eq(videoPosts.id, postId)).get();
  if (!post) throw new Error(`Post not found: ${postId}`);

  const burnEnabled = post.burnHook == null ? true : post.burnHook === 1;
  const instructions = post.instructions ? (JSON.parse(post.instructions) as { hook?: string }) : {};
  const hook = (instructions.hook ?? "").trim();

  // Nothing to serve as burned → drop any stale burned pointer AND file.
  if (!burnEnabled || !hook || !post.filePath) {
    if (post.burnedPath || post.burnedHook) {
      if (post.burnedPath) await deleteVideo(post.burnedPath).catch(() => {});
      db.update(videoPosts).set({ burnedPath: null, burnedHook: null, updatedAt: new Date().toISOString() }).where(eq(videoPosts.id, postId)).run();
    }
    return { burned: false, reason: !burnEnabled ? "disabled" : !hook ? "no hook" : "no render" };
  }

  // Already burned this exact hook and the file still exists → no-op.
  if (post.burnedHook === hook && post.burnedPath && (await videoStat(post.burnedPath)).exists) {
    return { burned: true, skipped: true, burnedPath: post.burnedPath };
  }

  const src = await materializeVideo(post.filePath);
  const tmpOut = videoScratchPath(`hook-${postId}.mp4`);
  const tmpTxt = videoScratchPath(`hook-${postId}.txt`);
  const outRel = burnedPathFor(post.filePath);
  try {
    const wrapped = wrapHook(hook);
    const lineCount = wrapped.split("\n").length;
    await writeFile(tmpTxt, wrapped, "utf-8");
    const fontSize = lineCount >= 3 ? 54 : 64;
    // Paths are POSIX (no colons) so the filtergraph needs no escaping, and
    // expansion=none makes drawtext render the textfile verbatim — a hook
    // containing \, {, } or %{ can't be mis-read as an escape/expansion.
    const vf =
      `drawtext=fontfile=${FONT}:textfile=${tmpTxt}:expansion=none:fontcolor=white:fontsize=${fontSize}:` +
      `box=1:boxcolor=black@0.5:boxborderw=22:line_spacing=14:` +
      `x=(w-text_w)/2:y=h*0.14:enable='between(t,0,${HOLD_SEC})'`;
    await runFfmpeg([
      "-y",
      "-i", src.path,
      "-vf", vf,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "copy",
      "-movflags", "+faststart",
      tmpOut,
    ]);
    await ffprobe(tmpOut); // validate the burned output is playable
    await storeVideoFile(tmpOut, outRel);
    db.update(videoPosts)
      .set({ burnedPath: outRel, burnedHook: hook, updatedAt: new Date().toISOString() })
      .where(eq(videoPosts.id, postId))
      .run();
    return { burned: true, burnedPath: outRel };
  } finally {
    await src.cleanup();
    await unlink(tmpOut).catch(() => {});
    await unlink(tmpTxt).catch(() => {});
  }
}
