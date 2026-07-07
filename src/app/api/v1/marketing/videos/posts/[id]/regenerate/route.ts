/**
 * POST /api/v1/marketing/videos/posts/[id]/regenerate
 *
 * { copyOnly: true }  → rerun the AI caption/instructions on the same video.
 * {} (default)        → discard this permutation and compose a FRESH edit
 *                       for the same slot (new post row, render enqueued).
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { videoPosts } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { deleteVideo } from "@/lib/storage/videos";
import { generateVideoCopy } from "@/modules/marketing/lib/video/video-ai";
import {
  composeAndInsertPost,
  loadComposerContext,
  type Slot,
} from "@/modules/marketing/lib/video/scheduler";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const post = db.select().from(videoPosts).where(eq(videoPosts.id, id)).get();
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { copyOnly?: boolean } = {};
  try {
    body = await request.json();
  } catch {
    /* empty body = full regenerate */
  }

  if (body.copyOnly) {
    if (!post.filePath) {
      return NextResponse.json({ error: "Video not rendered yet — copy comes with the render" }, { status: 400 });
    }
    const result = await generateVideoCopy(id);
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  }

  if (post.status === "posted") {
    return NextResponse.json({ error: "Post is already published — discard is not allowed" }, { status: 409 });
  }

  // Free the slot first (unique index), then compose a replacement.
  const slot =
    post.scheduledDate && post.scheduledSlot
      ? { date: post.scheduledDate, slot: post.scheduledSlot as Slot }
      : null;

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

  const ctx = loadComposerContext(slot?.date ?? new Date().toISOString().slice(0, 10));
  const { post: replacement, warning } = composeAndInsertPost(ctx, slot);

  if (!replacement) {
    return NextResponse.json(
      { discarded: true, replacement: null, warning: warning ?? "Could not compose a replacement" },
      { status: 200 },
    );
  }
  return NextResponse.json({ discarded: true, replacement }, { status: 201 });
}
