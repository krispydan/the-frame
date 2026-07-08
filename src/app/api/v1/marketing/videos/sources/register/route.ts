/**
 * POST /api/v1/marketing/videos/sources/register
 *
 * Step 2 of the direct-to-R2 raw-footage upload: record the source row +
 * queue the split job after the browser has PUT the bytes to R2. We HEAD
 * the object (no download) to confirm it landed; ffprobe (duration/dims
 * + the too-short-to-clip check) happens inside the split job, so the
 * 400MB file is never pulled back through this server.
 *
 * Body (JSON): { checksum, fileName, categoryId?, skuIds?, audioMode?,
 *                talent?, minClipSec?, maxClipSec?, maxClips?, sizeBytes? }
 * Response: { id, checksum, status, deduped }
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { videoSources } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { sourcePath, videoStat } from "@/lib/storage/videos";
import { jobQueue } from "@/modules/core/lib/job-queue";
import {
  ALLOWED_VIDEO_EXT,
  extFromName,
  isValidChecksum,
  parseSkuIds,
  resolveCategoryId,
} from "@/modules/marketing/lib/video/upload-shared";

export async function POST(request: NextRequest) {
  let body: {
    checksum?: string;
    fileName?: string;
    categoryId?: string;
    skuIds?: unknown;
    audioMode?: string;
    talent?: string;
    minClipSec?: number;
    maxClipSec?: number;
    maxClips?: number;
    sizeBytes?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const checksum = body.checksum;
  if (!isValidChecksum(checksum)) {
    return NextResponse.json({ error: "checksum must be 16 hex chars" }, { status: 400 });
  }
  const ext = extFromName(body.fileName || "");
  if (!ALLOWED_VIDEO_EXT.has(ext)) {
    return NextResponse.json({ error: `Unsupported type: ${ext}` }, { status: 400 });
  }

  const dupe = db.select().from(videoSources).where(eq(videoSources.checksum, checksum)).get();
  if (dupe) {
    return NextResponse.json({ id: dupe.id, checksum, status: dupe.status, deduped: true });
  }

  const rawRel = sourcePath(checksum, ext.slice(1));
  const stat = await videoStat(rawRel);
  if (!stat.exists) {
    return NextResponse.json({ error: "Uploaded file not found in storage" }, { status: 409 });
  }

  const categoryId = resolveCategoryId(body.categoryId);
  const skuIds = parseSkuIds(body.skuIds);
  const audioMode = body.audioMode === "keep" ? "keep" : "mute";
  const talent = (body.talent || "").trim() || null;
  const minClipSec = Math.min(Math.max(Number(body.minClipSec) || 3, 2), 10);
  const maxClipSec = Math.min(Math.max(Number(body.maxClipSec) || 5, minClipSec), 12);
  const maxClips = Math.min(Math.max(Number(body.maxClips) || 40, 1), 200);

  const id = crypto.randomUUID();
  db.insert(videoSources)
    .values({
      id,
      fileName: body.fileName || `${checksum}${ext}`,
      checksum,
      rawPath: rawRel,
      sizeBytes: stat.size || body.sizeBytes || null,
      status: "uploaded",
      minClipSec,
      maxClipSec,
      maxClips,
      categoryId,
      talent,
      audioMode,
      skuIds: JSON.stringify(skuIds),
    })
    .run();

  // Split validates the bytes (and the too-short-to-clip case); a bad
  // upload lands as status=failed on the source.
  jobQueue.enqueue("marketing.video.split-source", "marketing", { sourceId: id }, { priority: 3 });

  return NextResponse.json({ id, checksum, status: "uploaded", deduped: false }, { status: 201 });
}
