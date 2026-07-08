/**
 * /api/v1/marketing/videos/sources/[id]
 *
 * POST /resplit — re-enqueue the split job (after a failure, or to pick
 *        up windows a crash skipped; existing clips are never duplicated).
 * DELETE — remove the source row + its raw file. Generated clips stay
 *        (they're independent library assets); pass ?clips=archive to
 *        also archive every clip that came from this source.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { videoSources } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { deleteVideo } from "@/lib/storage/videos";
import { jobQueue } from "@/modules/core/lib/job-queue";

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const source = db.select().from(videoSources).where(eq(videoSources.id, id)).get();
  if (!source) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (source.status === "splitting") {
    return NextResponse.json({ error: "Already splitting" }, { status: 409 });
  }
  if (source.rawDeleted) {
    return NextResponse.json(
      { error: "Original footage was removed after clipping — re-upload it to re-clip." },
      { status: 409 },
    );
  }

  db.update(videoSources)
    .set({ status: "uploaded", error: null, updatedAt: new Date().toISOString() })
    .where(eq(videoSources.id, id))
    .run();
  const jobId = jobQueue.enqueue("marketing.video.split-source", "marketing", { sourceId: id }, { priority: 2 });
  return NextResponse.json({ enqueued: true, jobId });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const source = db.select().from(videoSources).where(eq(videoSources.id, id)).get();
  if (!source) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let archivedClips = 0;
  if (request.nextUrl.searchParams.get("clips") === "archive") {
    archivedClips = sqlite
      .prepare(`UPDATE marketing_video_clips SET status='archived', updated_at=datetime('now') WHERE source_id = ? AND status != 'archived'`)
      .run(id).changes;
  }

  db.delete(videoSources).where(eq(videoSources.id, id)).run();
  await deleteVideo(source.rawPath).catch(() => {});

  return NextResponse.json({ deleted: true, archivedClips });
}
