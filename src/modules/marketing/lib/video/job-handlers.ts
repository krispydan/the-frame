/**
 * Background job handlers for the Video Remix Studio.
 *
 * Side-effect module — imported once from job-worker.ts (same pattern
 * as @/modules/sales/lib/status-sync). Both handlers are idempotent:
 * the queue is at-least-once (15-min stuck reset + up to 3 attempts),
 * so re-running a completed step must be a no-op.
 */
import { registerJobHandler } from "@/modules/core/lib/job-handler-registry";

registerJobHandler("marketing.video.normalize-clip", async (input) => {
  const clipId = input.clipId;
  if (!clipId || typeof clipId !== "string") {
    throw new Error("clipId is required for marketing.video.normalize-clip jobs");
  }
  const { normalizeClip } = await import("./normalize");
  return (await normalizeClip(clipId)) as unknown as Record<string, unknown>;
});

registerJobHandler("marketing.video.render-post", async (input) => {
  const postId = input.postId;
  if (!postId || typeof postId !== "string") {
    throw new Error("postId is required for marketing.video.render-post jobs");
  }
  const { renderPost } = await import("./render");
  const render = await renderPost(postId);

  // Copy generation is best-effort: a failed AI call leaves the post
  // `rendered` (video usable, copy regenerable via the queue UI).
  const { generateVideoCopy } = await import("./video-ai");
  const copy = await generateVideoCopy(postId).catch((e) => ({
    ok: false as const,
    usedFallback: true,
    error: e instanceof Error ? e.message : String(e),
  }));

  return { ...render, copy } as unknown as Record<string, unknown>;
});
