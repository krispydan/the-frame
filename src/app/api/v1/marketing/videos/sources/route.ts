/**
 * /api/v1/marketing/videos/sources — raw footage for the auto-clipper.
 *
 * POST — multipart upload of one raw video (Uppy posts one per request):
 *   file       — required, video/*, up to 400MB
 *   categoryId — optional, id or slug — stamped on every generated clip
 *   skuIds     — optional, JSON array / comma list — stamped on clips
 *   audioMode  — optional, "mute" (default) | "keep" — stamped on clips
 *   talent     — optional, person in the footage — stamped on clips
 *   minClipSec / maxClipSec / maxClips — optional split settings
 *   Dedupes by checksum; enqueues the split job on create.
 *
 * GET — list sources with status + clip counts.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import path from "path";
import { db, sqlite } from "@/lib/db";
import { videoSources } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { saveVideo, sourcePath, materializeVideo, videoStat } from "@/lib/storage/videos";
import { ffprobe } from "@/modules/marketing/lib/video/ffmpeg";
import { jobQueue } from "@/modules/core/lib/job-queue";

// Raw shoot exports are big. 400MB ≈ 2-4 min of 1080p60 phone footage.
// Bodies buffer in memory (see proxyClientMaxBodySize in next.config.ts),
// so the uploader runs these one at a time.
const MAX_SIZE = 400 * 1024 * 1024;
const ALLOWED_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);

function parseSkuIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch { /* comma fallback */ }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export async function GET() {
  const sources = sqlite.prepare(`
    SELECT s.*, cat.name AS category_name,
      (SELECT COUNT(*) FROM marketing_video_clips c WHERE c.source_id = s.id AND c.status = 'ready') AS ready_clips
    FROM marketing_video_sources s
    LEFT JOIN marketing_video_clip_categories cat ON cat.id = s.category_id
    ORDER BY s.created_at DESC
    LIMIT 100
  `).all();
  return NextResponse.json({ sources });
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
    return NextResponse.json(
      { error: `Too large: ${(file.size / 1e6).toFixed(0)}MB (max 400MB — export long shoots in parts)` },
      { status: 413 },
    );
  }
  const ext = path.extname(file.name || "").toLowerCase() || ".mp4";
  if (!file.type.startsWith("video/") && !ALLOWED_EXT.has(ext)) {
    return NextResponse.json({ error: `Unsupported type: ${file.type || ext}` }, { status: 400 });
  }

  const categoryRaw = (formData.get("categoryId") as string) || "";
  let categoryId: string | null = null;
  if (categoryRaw) {
    const cat = sqlite
      .prepare(`SELECT id FROM marketing_video_clip_categories WHERE (id = ? OR slug = ?) AND archived = 0`)
      .get(categoryRaw, categoryRaw) as { id: string } | undefined;
    categoryId = cat?.id ?? null;
  }
  const skuIds = parseSkuIds(formData.get("skuIds") as string | null);
  const audioMode = (formData.get("audioMode") as string) === "keep" ? "keep" : "mute";
  const talent = ((formData.get("talent") as string) || "").trim() || null;
  const minClipSec = Math.min(Math.max(Number(formData.get("minClipSec")) || 3, 2), 10);
  const maxClipSec = Math.min(Math.max(Number(formData.get("maxClipSec")) || 5, minClipSec), 12);
  const maxClips = Math.min(Math.max(Number(formData.get("maxClips")) || 40, 1), 200);

  const buffer = Buffer.from(await file.arrayBuffer());
  const checksum = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const rawRel = sourcePath(checksum, ext.slice(1));

  const existingFile = await videoStat(rawRel);
  if (!existingFile.exists) await saveVideo(buffer, rawRel);

  let probe;
  const mat = await materializeVideo(rawRel);
  try {
    probe = await ffprobe(mat.path);
  } catch {
    return NextResponse.json({ error: "File is not a decodable video" }, { status: 400 });
  } finally {
    await mat.cleanup();
  }
  if (probe.durationSec < minClipSec) {
    return NextResponse.json(
      { error: `Video is ${probe.durationSec.toFixed(1)}s — shorter than one clip. Upload it as a clip instead.` },
      { status: 400 },
    );
  }

  const dupe = db.select().from(videoSources).where(eq(videoSources.checksum, checksum)).get();
  if (dupe) {
    return NextResponse.json({ id: dupe.id, checksum, status: dupe.status, deduped: true });
  }

  const id = crypto.randomUUID();
  db.insert(videoSources)
    .values({
      id,
      fileName: file.name || `${checksum}${ext}`,
      checksum,
      rawPath: rawRel,
      durationSec: probe.durationSec,
      width: probe.width,
      height: probe.height,
      sizeBytes: buffer.length,
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

  jobQueue.enqueue("marketing.video.split-source", "marketing", { sourceId: id }, { priority: 3 });

  return NextResponse.json({ id, checksum, status: "uploaded", deduped: false }, { status: 201 });
}
