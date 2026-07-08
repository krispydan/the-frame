/**
 * POST /api/v1/marketing/videos/sources/presign
 *
 * Step 1 of the direct-to-R2 raw-footage upload for the auto-clipper.
 * Raw shoot exports are the biggest files (up to 400MB) and buffering
 * them through the server is exactly what OOM'd — so they go straight to
 * R2 via a presigned PUT.
 *
 * Body (JSON): { fileName, checksum, contentType? }
 * Response: { direct: true, uploadUrl, key, checksum, headers }
 *           | { direct: true, deduped: true, id, status }
 *           | 409 { direct: false }   (R2 off → through-server fallback)
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import {
  sourcePath,
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

  // Content-addressed key + /register dedupe → always hand back an upload
  // URL and keep the browser flow simple (re-PUT of identical bytes is a
  // no-op object write).
  const key = sourcePath(checksum, ext.slice(1));
  const contentType = body.contentType || contentTypeForExt(ext);
  const uploadUrl = await presignVideoUpload(key, contentType);

  return NextResponse.json({
    direct: true,
    uploadUrl,
    key,
    checksum,
    headers: { "Content-Type": contentType },
  });
}
