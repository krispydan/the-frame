/**
 * POST /api/v1/marketing/videos/clips/register
 *
 * Step 2 of the direct-to-R2 clip upload: after the browser PUTs the
 * bytes to R2, it calls this to record the DB row + queue normalization.
 * We confirm the object exists (HEAD — no download), then create the
 * clip; ffprobe validation + dimensions happen in the normalize job, so
 * a huge file is never pulled back through this server.
 *
 * Body (JSON): { checksum, fileName, categoryId?, skuIds?, audioMode?,
 *                talent?, notes?, sizeBytes? }
 * Response: { id, checksum, status, deduped }
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { videoClips } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { rawClipPath, videoStat } from "@/lib/storage/videos";
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
    notes?: string;
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

  // Idempotent: if the row already exists (dupe bytes, or a retried
  // register), return it instead of erroring on the unique checksum.
  const dupe = db.select().from(videoClips).where(eq(videoClips.checksum, checksum)).get();
  if (dupe) {
    return NextResponse.json({ id: dupe.id, checksum, status: dupe.status, deduped: true });
  }

  const rawRel = rawClipPath(checksum, ext.slice(1));
  const stat = await videoStat(rawRel);
  if (!stat.exists) {
    // The PUT didn't land — client should retry the upload.
    return NextResponse.json({ error: "Uploaded file not found in storage" }, { status: 409 });
  }

  const categoryId = resolveCategoryId(body.categoryId);
  const skuIds = parseSkuIds(body.skuIds);
  const audioMode = body.audioMode === "keep" ? "keep" : "mute";
  const talent = (body.talent || "").trim() || null;
  const notes = body.notes || null;

  const id = crypto.randomUUID();
  db.insert(videoClips)
    .values({
      id,
      fileName: body.fileName || `${checksum}${ext}`,
      checksum,
      rawPath: rawRel,
      sizeBytes: stat.size || body.sizeBytes || null,
      categoryId,
      audioMode,
      talent,
      notes,
      status: "uploaded",
    })
    .run();

  const insertProduct = sqlite.prepare(
    `INSERT OR IGNORE INTO marketing_video_clip_products (id, clip_id, sku_id) VALUES (?, ?, ?)`,
  );
  for (const skuId of skuIds) insertProduct.run(crypto.randomUUID(), id, skuId);

  // Normalize validates the bytes; a bad upload lands as status=failed.
  jobQueue.enqueue("marketing.video.normalize-clip", "marketing", { clipId: id }, { priority: 3 });

  return NextResponse.json({ id, checksum, status: "uploaded", deduped: false }, { status: 201 });
}
