/**
 * POST /api/v1/marketing/videos/clips/presign
 *
 * Step 1 of the direct-to-R2 clip upload: the browser sends the file's
 * content-address (sha256) + name; we return a presigned PUT URL it can
 * upload the bytes straight to R2 with — the file never streams through
 * this server (that buffering was the OOM that broke big uploads).
 *
 * Body (JSON): { fileName, checksum, contentType? }
 * Response: { direct: true, uploadUrl, key, checksum, headers }
 *           | { direct: true, deduped: true, id, status }   (already have it)
 *           | 409 { direct: false }                          (R2 off → client
 *                                                             falls back to the
 *                                                             through-server route)
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import {
  rawClipPath,
  videosDirectUpload,
  presignVideoUpload,
} from "@/lib/storage/videos";
import {
  ALLOWED_VIDEO_EXT,
  extFromName,
  contentTypeForExt,
  isValidChecksum,
} from "@/modules/marketing/lib/video/upload-shared";

export async function POST(request: NextRequest) {
  if (!videosDirectUpload()) {
    return NextResponse.json({ direct: false }, { status: 409 });
  }

  let body: { fileName?: string; checksum?: string; contentType?: string };
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

  // Content-addressed key: re-PUTting identical bytes is idempotent, and
  // /register dedupes the DB row — so we always hand back an upload URL and
  // let register decide, keeping the browser flow simple.
  const key = rawClipPath(checksum, ext.slice(1));
  const contentType = body.contentType || contentTypeForExt(ext);
  const uploadUrl = await presignVideoUpload(key, contentType);

  return NextResponse.json({
    direct: true,
    uploadUrl,
    key,
    checksum,
    // The browser MUST send this exact Content-Type or the signature fails.
    headers: { "Content-Type": contentType },
  });
}
