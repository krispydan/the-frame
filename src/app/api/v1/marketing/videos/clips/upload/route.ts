/**
 * POST /api/v1/marketing/videos/clips/upload
 *
 * Upload one raw clip into the video library (Uppy posts one file per
 * request). Pattern follows catalog/images/upload-raw: sha256 checksum,
 * content-addressed path, dedupe by checksum, DB row + background job.
 *
 * multipart/form-data:
 *   file       — required, video/*
 *   categoryId — optional, category id OR slug (batch default from the UI)
 *   skuIds     — optional, JSON array or comma-separated catalog_skus ids
 *   audioMode  — optional, "mute" (default) | "keep"
 *   notes      — optional
 *
 * Re-uploading identical bytes re-saves the file (volume-wipe
 * resilience) and returns the existing row instead of erroring.
 *
 * Response: { id, checksum, status, deduped }
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import path from "path";
import { db, sqlite } from "@/lib/db";
import { videoClips } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { saveVideo, rawClipPath, getVideoFullPath, videoStat } from "@/lib/storage/videos";
import { ffprobe } from "@/modules/marketing/lib/video/ffmpeg";
import { jobQueue } from "@/modules/core/lib/job-queue";

const MAX_SIZE = 200 * 1024 * 1024; // 200 MB — plenty for 5-10s phone clips
const ALLOWED_EXT = new Set([".mp4", ".mov", ".m4v", ".webm"]);

function parseSkuIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    /* fall through to comma parsing */
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function resolveCategoryId(raw: string | null): string | null {
  if (!raw) return null;
  const row = sqlite
    .prepare(`SELECT id FROM marketing_video_clip_categories WHERE (id = ? OR slug = ?) AND archived = 0`)
    .get(raw, raw) as { id: string } | undefined;
  return row?.id ?? null;
}

export async function POST(request: NextRequest) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file field is required" }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: `Too large: ${file.size} bytes (max ${MAX_SIZE})` }, { status: 413 });
  }
  const ext = path.extname(file.name || "").toLowerCase() || ".mp4";
  if (!file.type.startsWith("video/") && !ALLOWED_EXT.has(ext)) {
    return NextResponse.json({ error: `Unsupported type: ${file.type || ext}` }, { status: 400 });
  }

  const categoryId = resolveCategoryId(formData.get("categoryId") as string | null);
  const skuIds = parseSkuIds(formData.get("skuIds") as string | null);
  const audioMode = (formData.get("audioMode") as string) === "keep" ? "keep" : "mute";
  const notes = (formData.get("notes") as string) || null;

  const buffer = Buffer.from(await file.arrayBuffer());
  const checksum = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const rawRel = rawClipPath(checksum, ext.slice(1));

  // Always (re-)save the bytes — content-addressed, so this heals a
  // wiped volume without churning the DB.
  const existing = await videoStat(rawRel);
  if (!existing.exists) {
    await saveVideo(buffer, rawRel);
  }

  // Validate it's actually decodable video before creating a row.
  let probe;
  try {
    probe = await ffprobe(getVideoFullPath(rawRel));
  } catch {
    return NextResponse.json({ error: "File is not a decodable video" }, { status: 400 });
  }
  if (probe.durationSec < 1 || probe.durationSec > 120) {
    return NextResponse.json(
      { error: `Clip duration ${probe.durationSec.toFixed(1)}s out of range (1-120s)` },
      { status: 400 },
    );
  }

  // Dedupe by checksum.
  const dupe = db.select().from(videoClips).where(eq(videoClips.checksum, checksum)).get();
  if (dupe) {
    return NextResponse.json({ id: dupe.id, checksum, status: dupe.status, deduped: true });
  }

  const id = crypto.randomUUID();
  db.insert(videoClips)
    .values({
      id,
      fileName: file.name || `${checksum}${ext}`,
      checksum,
      rawPath: rawRel,
      sizeBytes: buffer.length,
      width: probe.width,
      height: probe.height,
      categoryId,
      audioMode,
      notes,
      status: "uploaded",
    })
    .run();

  const insertProduct = sqlite.prepare(
    `INSERT OR IGNORE INTO marketing_video_clip_products (id, clip_id, sku_id) VALUES (?, ?, ?)`,
  );
  for (const skuId of skuIds) insertProduct.run(crypto.randomUUID(), id, skuId);

  jobQueue.enqueue("marketing.video.normalize-clip", "marketing", { clipId: id }, { priority: 3 });

  return NextResponse.json({ id, checksum, status: "uploaded", deduped: false }, { status: 201 });
}
