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

registerJobHandler("marketing.tiktok-sounds.sync", async () => {
  // Runs the Apify sync server-side so no browser connection is held
  // open (that hang → proxy-retry → duplicate paid runs was the bug).
  // Errors are RETURNED, not thrown, so the queue never retries an
  // external paid API on transient failure.
  const { syncTrendingSounds } = await import("./tiktok-sounds");
  try {
    return (await syncTrendingSounds()) as unknown as Record<string, unknown>;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn(`[tiktok-sounds] sync job failed (no retry): ${error}`);
    return { synced: 0, error };
  }
});

registerJobHandler("marketing.video.split-source", async (input) => {
  const sourceId = input.sourceId;
  if (!sourceId || typeof sourceId !== "string") {
    throw new Error("sourceId is required for marketing.video.split-source jobs");
  }
  const { splitSource } = await import("./split");
  return (await splitSource(sourceId)) as unknown as Record<string, unknown>;
});

registerJobHandler("marketing.media.identify", async (input) => {
  // Legacy handler (identification is synchronous filename matching now,
  // run directly by the media-match route) — kept so any jobs queued
  // before the cutover still drain cleanly instead of erroring.
  const mediaType = input.mediaType;
  const mediaId = input.mediaId;
  if ((mediaType !== "clip" && mediaType !== "image") || typeof mediaId !== "string" || !mediaId) {
    throw new Error("mediaType (clip|image) and mediaId are required for marketing.media.identify jobs");
  }
  const { identifyMedia } = await import("./sku-match");
  return identifyMedia(mediaType, mediaId, { apply: false }) as unknown as Record<string, unknown>;
});

registerJobHandler("marketing.media.frameshape-all", async () => {
  // Bulk AI identification: run frame-shape matching (+ video-type
  // classification) over EVERY ready clip that has no products tagged and
  // hasn't been reviewed. Idempotent: suggestFrameShape never touches
  // confirmed rows, and re-running just refreshes suggestions. Runs in the
  // background worker so there's no request-timeout cap.
  const { sqlite } = await import("@/lib/db");
  const { suggestFrameShape } = await import("./frame-shape");

  const ids = (sqlite.prepare(`
    SELECT c.id FROM marketing_video_clips c
    LEFT JOIN marketing_media_matches m ON m.media_type = 'clip' AND m.media_id = c.id
    WHERE c.status = 'ready'
      AND NOT EXISTS (SELECT 1 FROM marketing_video_clip_products cp WHERE cp.clip_id = c.id)
      AND (m.status IS NULL OR m.status NOT IN ('confirmed','no_product'))
    ORDER BY c.created_at DESC
  `).all() as Array<{ id: string }>).map((r) => r.id);

  let suggested = 0;
  let none = 0;
  let failed = 0;
  let costUsd = 0;
  for (const [i, clipId] of ids.entries()) {
    try {
      const r = await suggestFrameShape("clip", clipId);
      costUsd += r.costUsd ?? 0;
      if (r.status === "suggested") suggested++;
      else if (r.status === "failed") failed++;
      else none++;
    } catch (e) {
      failed++;
      console.warn(`[frame-shape] bulk: clip ${clipId} failed: ${e instanceof Error ? e.message : e}`);
    }
    if ((i + 1) % 10 === 0) {
      console.info(`[frame-shape] bulk progress: ${i + 1}/${ids.length}, cost so far ≈ $${costUsd.toFixed(2)}`);
    }
  }
  console.info(
    `[frame-shape] bulk done: ${ids.length} clips — ${suggested} suggested, ${none} no-clear-shot, ${failed} failed, total ≈ $${costUsd.toFixed(2)}`,
  );
  return { scanned: ids.length, suggested, none, failed, costUsd: Math.round(costUsd * 10000) / 10000 };
});

registerJobHandler("marketing.video.render-post", async (input) => {
  const postId = input.postId;
  if (!postId || typeof postId !== "string") {
    throw new Error("postId is required for marketing.video.render-post jobs");
  }
  const { renderPost } = await import("./render");
  const render = await renderPost(postId);

  // skipCopy: a clip-edit re-render keeps the existing (possibly
  // hand-edited) caption — flip straight back to ready instead of
  // regenerating copy over the operator's words.
  if (input.skipCopy === true) {
    const { db: appDb } = await import("@/lib/db");
    const { videoPosts } = await import("@/modules/marketing/schema");
    const { eq } = await import("drizzle-orm");
    const post = appDb.select().from(videoPosts).where(eq(videoPosts.id, postId)).get();
    if (post?.caption && post.status === "rendered") {
      appDb
        .update(videoPosts)
        .set({ status: "ready", updatedAt: new Date().toISOString() })
        .where(eq(videoPosts.id, postId))
        .run();
    }
    return { ...render, copy: { ok: true, skipped: true } } as unknown as Record<string, unknown>;
  }

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
