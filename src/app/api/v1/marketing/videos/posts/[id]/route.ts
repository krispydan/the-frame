/**
 * /api/v1/marketing/videos/posts/[id]
 *
 * GET    — post detail (clips, urls, parsed JSON fields)
 * PATCH  — edit caption/hashtags, transition status (ready→posted sets
 *          postedAt), reschedule { scheduledDate, scheduledSlot }.
 * DELETE — discard: status=discarded, slot freed, render files removed.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { videoPosts } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { deleteVideo, videoUrl } from "@/lib/storage/videos";
import { SLOTS, type Slot } from "@/modules/marketing/lib/video/scheduler";
import { permutationHash, FALLBACK_RECIPE_ID } from "@/modules/marketing/lib/video/composer";
import { jobQueue } from "@/modules/core/lib/job-queue";

type Params = { params: Promise<{ id: string }> };

/** Manual statuses an operator can set. rendered→ready happens via AI. */
const OPERATOR_STATUSES = new Set(["ready", "posted", "queued"]);

function loadPost(id: string) {
  const row = sqlite.prepare(`
    SELECT p.*, r.name AS recipe_name
    FROM marketing_video_posts p
    LEFT JOIN marketing_video_recipes r ON r.id = p.recipe_id
    WHERE p.id = ?
  `).get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;

  const clipStmt = sqlite.prepare(`
    SELECT c.id, c.file_name AS fileName, c.duration_sec AS durationSec,
           c.poster_path AS posterPath, c.audio_mode AS audioMode, cat.slug AS category
    FROM marketing_video_clips c
    LEFT JOIN marketing_video_clip_categories cat ON cat.id = c.category_id
    WHERE c.id = ?
  `);
  const clipIds = JSON.parse(String(row.clip_ids || "[]")) as string[];
  return {
    ...row,
    videoUrl: row.file_path ? videoUrl(String(row.file_path)) : null,
    posterUrl: row.poster_path ? videoUrl(String(row.poster_path)) : null,
    hashtags: row.hashtags ? JSON.parse(String(row.hashtags)) : [],
    instructions: row.instructions ? JSON.parse(String(row.instructions)) : null,
    aiContext: row.ai_context ? JSON.parse(String(row.ai_context)) : null,
    clips: clipIds.map((cid, i) => {
      const clip = clipStmt.get(cid) as Record<string, unknown> | undefined;
      return {
        position: i + 1,
        id: cid,
        ...clip,
        posterUrl: clip?.posterPath ? videoUrl(String(clip.posterPath)) : null,
      };
    }),
  };
}

export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const post = loadPost(id);
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ post });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const existing = db.select().from(videoPosts).where(eq(videoPosts.id, id)).get();
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: Partial<typeof videoPosts.$inferInsert> = { updatedAt: new Date().toISOString() };
  let rerenderQueued = false;

  if (body.caption !== undefined) updates.caption = String(body.caption);
  // Posting instructions (text overlay, audio note, cover, first comment)
  // edited directly in the detail page.
  if (body.instructions !== undefined) {
    if (typeof body.instructions !== "object" || body.instructions === null) {
      return NextResponse.json({ error: "instructions must be an object" }, { status: 400 });
    }
    updates.instructions = JSON.stringify(body.instructions);
  }

  // ── Mini editor: replace the clip sequence → reset render + re-render ──
  if (body.clipIds !== undefined) {
    if (!Array.isArray(body.clipIds) || body.clipIds.length === 0) {
      return NextResponse.json({ error: "clipIds must be a non-empty array" }, { status: 400 });
    }
    if (existing.status === "posted") {
      return NextResponse.json({ error: "Cannot edit clips on a posted video" }, { status: 400 });
    }
    const newClipIds = body.clipIds.map(String);
    const clipStmt = sqlite.prepare(
      `SELECT id, status, duration_sec AS durationSec FROM marketing_video_clips WHERE id = ?`,
    );
    let newDuration = 0;
    for (const cid of new Set(newClipIds)) {
      const clip = clipStmt.get(cid) as { id: string; status: string; durationSec: number | null } | undefined;
      if (!clip) return NextResponse.json({ error: `Clip not found: ${cid}` }, { status: 400 });
      if (clip.status !== "ready") {
        return NextResponse.json({ error: `Clip ${cid} is not ready (status: ${clip.status})` }, { status: 400 });
      }
    }
    for (const cid of newClipIds) {
      newDuration += (clipStmt.get(cid) as { durationSec: number | null }).durationSec ?? 0;
    }

    // Audio: keep the previously-audible clips that survived the edit.
    const oldAudible = JSON.parse(existing.audibleClipIds || "[]") as string[];
    const keep = new Set(newClipIds);
    const audible = oldAudible.filter((cid) => keep.has(cid));
    const audioTreatment: "silent" | "partial" | "full" =
      audible.length === 0 ? "silent" : audible.length === newClipIds.length ? "full" : "partial";

    updates.clipIds = JSON.stringify(newClipIds);
    updates.audibleClipIds = JSON.stringify(audible);
    updates.audioTreatment = audioTreatment;
    updates.permutationHash = permutationHash(existing.recipeId ?? FALLBACK_RECIPE_ID, newClipIds, audioTreatment);
    updates.durationSec = newDuration;
    // Reset the render: old files removed after a successful DB update.
    updates.filePath = null;
    updates.posterPath = null;
    updates.sizeBytes = null;
    updates.status = "queued";
    updates.error = null;
    rerenderQueued = true;
  }
  if (body.hashtags !== undefined) {
    if (!Array.isArray(body.hashtags)) {
      return NextResponse.json({ error: "hashtags must be an array" }, { status: 400 });
    }
    updates.hashtags = JSON.stringify(body.hashtags.map(String));
  }
  if (body.platform !== undefined) {
    if (!["tiktok", "instagram", "both"].includes(String(body.platform))) {
      return NextResponse.json({ error: "platform must be tiktok | instagram | both" }, { status: 400 });
    }
    updates.platform = body.platform as "tiktok" | "instagram" | "both";
  }
  if (body.status !== undefined) {
    const status = String(body.status);
    if (!OPERATOR_STATUSES.has(status)) {
      return NextResponse.json({ error: `status must be one of: ${[...OPERATOR_STATUSES].join(", ")}` }, { status: 400 });
    }
    if (status === "posted" && !existing.filePath) {
      return NextResponse.json({ error: "Cannot mark posted — video not rendered yet" }, { status: 400 });
    }
    updates.status = status as "ready" | "posted" | "queued";
    if (status === "posted") updates.postedAt = new Date().toISOString();
  }

  // Reschedule (both fields together, or clear both with nulls).
  if (body.scheduledDate !== undefined || body.scheduledSlot !== undefined) {
    const date = body.scheduledDate as string | null;
    const slot = body.scheduledSlot as string | null;
    if ((date == null) !== (slot == null)) {
      return NextResponse.json({ error: "scheduledDate and scheduledSlot must be set (or cleared) together" }, { status: 400 });
    }
    if (date != null) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !SLOTS.includes(slot as Slot)) {
        return NextResponse.json({ error: "Invalid scheduledDate/scheduledSlot" }, { status: 400 });
      }
    }
    updates.scheduledDate = date;
    updates.scheduledSlot = slot as Slot | null;
  }

  try {
    db.update(videoPosts).set(updates).where(eq(videoPosts.id, id)).run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("idx_video_post_slot")) {
      return NextResponse.json({ error: "That slot already has a post" }, { status: 409 });
    }
    if (msg.includes("permutation_hash")) {
      return NextResponse.json({ error: "A video with this exact clip sequence already exists" }, { status: 409 });
    }
    throw e;
  }

  if (rerenderQueued) {
    // Old render files are stale now — remove, then queue the re-render.
    if (existing.filePath) await deleteVideo(existing.filePath).catch(() => {});
    if (existing.posterPath) await deleteVideo(existing.posterPath).catch(() => {});
    // skipCopy: a post that already has a caption keeps it (the operator
    // may have hand-edited it); a fresh post gets AI copy as usual.
    jobQueue.enqueue(
      "marketing.video.render-post",
      "marketing",
      { postId: id, skipCopy: Boolean(existing.caption) },
      { priority: 2 },
    );
  }

  return NextResponse.json({ post: loadPost(id), rerenderQueued });
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const post = db.select().from(videoPosts).where(eq(videoPosts.id, id)).get();
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Free the slot + remove render files; keep the row (permutation hash
  // stays burned so the same edit is never regenerated).
  db.update(videoPosts)
    .set({
      status: "discarded",
      scheduledDate: null,
      scheduledSlot: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(videoPosts.id, id))
    .run();

  if (post.filePath) await deleteVideo(post.filePath).catch(() => {});
  if (post.posterPath) await deleteVideo(post.posterPath).catch(() => {});

  return NextResponse.json({ discarded: true });
}
