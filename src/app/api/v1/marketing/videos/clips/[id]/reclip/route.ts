/**
 * POST /api/v1/marketing/videos/clips/[id]/reclip
 *
 * Auto-clip an ALREADY-UPLOADED clip in place — for videos that went in
 * whole (before auto-clip was the default) and should be split into 3–5s
 * clips. We register the clip's raw file as a new auto-clip source, queue
 * the split, and archive the original whole clip. The split produces the
 * short clips and (on success) deletes the shared raw file.
 *
 * Body (JSON, optional): { minClipSec?, maxClipSec?, maxClips? }
 * Response: { sourceId, queued, archivedOriginal }
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { videoClips, videoSources } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { videoStat } from "@/lib/storage/videos";
import { jobQueue } from "@/modules/core/lib/job-queue";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const clip = db.select().from(videoClips).where(eq(videoClips.id, id)).get();
  if (!clip) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!clip.rawPath) {
    return NextResponse.json({ error: "Clip has no raw file to re-clip" }, { status: 400 });
  }

  const raw = await videoStat(clip.rawPath);
  if (!raw.exists) {
    return NextResponse.json(
      { error: "This clip's original file is no longer in storage — re-upload it to clip it." },
      { status: 409 },
    );
  }

  let body: { minClipSec?: number; maxClipSec?: number; maxClips?: number } = {};
  try {
    body = await request.json();
  } catch {
    /* body is optional */
  }
  const minClipSec = Math.min(Math.max(Number(body.minClipSec) || 3, 2), 10);
  const maxClipSec = Math.min(Math.max(Number(body.maxClipSec) || 5, minClipSec), 12);
  const maxClips = Math.min(Math.max(Number(body.maxClips) || 40, 1), 200);

  // Carry the clip's tags onto every generated sub-clip.
  const skuIds = (sqlite
    .prepare(`SELECT sku_id AS skuId FROM marketing_video_clip_products WHERE clip_id = ?`)
    .all(id) as Array<{ skuId: string }>).map((r) => r.skuId);

  // A source is keyed by the raw file's checksum; if this clip was already
  // sent to re-clip, reuse that source instead of colliding on the unique
  // checksum — re-queue its split if it isn't done.
  let source = db.select().from(videoSources).where(eq(videoSources.checksum, clip.checksum)).get();
  if (source) {
    if (source.status !== "done" && source.status !== "splitting") {
      db.update(videoSources)
        .set({ status: "uploaded", error: null, updatedAt: new Date().toISOString() })
        .where(eq(videoSources.id, source.id))
        .run();
      jobQueue.enqueue("marketing.video.split-source", "marketing", { sourceId: source.id }, { priority: 2 });
    }
  } else {
    const sourceId = crypto.randomUUID();
    db.insert(videoSources)
      .values({
        id: sourceId,
        fileName: clip.fileName,
        checksum: clip.checksum,
        // Reuse the existing raw file in place — no copy. The split job
        // deletes it once the sub-clips are made.
        rawPath: clip.rawPath,
        durationSec: clip.durationSec,
        width: clip.width,
        height: clip.height,
        sizeBytes: clip.sizeBytes,
        status: "uploaded",
        minClipSec,
        maxClipSec,
        maxClips,
        categoryId: clip.categoryId,
        talent: clip.talent,
        audioMode: clip.audioMode,
        skuIds: JSON.stringify(skuIds),
      })
      .run();
    source = db.select().from(videoSources).where(eq(videoSources.id, sourceId)).get()!;
    jobQueue.enqueue("marketing.video.split-source", "marketing", { sourceId }, { priority: 2 });
  }

  // Archive the original whole clip so it stops being composed; existing
  // renders that already used it keep their history.
  db.update(videoClips)
    .set({ status: "archived", updatedAt: new Date().toISOString() })
    .where(eq(videoClips.id, id))
    .run();

  return NextResponse.json({ sourceId: source.id, queued: true, archivedOriginal: true });
}
