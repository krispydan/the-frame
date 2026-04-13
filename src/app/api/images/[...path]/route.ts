/**
 * Public image-serving route.
 *
 * GET /api/images/<...path>  →  raw file from IMAGES_ROOT
 *
 * Responses are immutable (content-addressed by checksum) so we cache
 * aggressively: Cache-Control: public, max-age=31536000, immutable.
 *
 * Path traversal is blocked by getFullPath() in src/lib/storage/local.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "fs/promises";
import path from "path";
import { getFullPath } from "@/lib/storage/local";

export const dynamic = "force-dynamic";

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await params;
  if (!segments || segments.length === 0) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Decode each segment (handles spaces and special chars in filenames)
  const relPath = segments.map((s) => decodeURIComponent(s)).join("/");

  let full: string;
  try {
    full = getFullPath(relPath);
  } catch {
    return new NextResponse("Forbidden", { status: 403 });
  }

  let fileStat;
  try {
    fileStat = await stat(full);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store, no-cache, must-revalidate", "CDN-Cache-Control": "no-store" } });
    }
    throw err;
  }
  if (!fileStat.isFile()) {
    return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store, no-cache, must-revalidate", "CDN-Cache-Control": "no-store" } });
  }

  const buffer = await readFile(full);
  const ext = path.extname(full).toLowerCase();
  const contentType = MIME_BY_EXT[ext] || "application/octet-stream";

  // Use mtime+size as a weak ETag fallback — for sharp-processed files the
  // filename IS the checksum, so this is still stable across requests.
  const etag = `"${fileStat.size}-${fileStat.mtimeMs.toString(16)}"`;

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(buffer.length),
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: etag,
    },
  });
}
