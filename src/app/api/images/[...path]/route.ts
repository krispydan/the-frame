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
import { readFromR2IfPresent } from "@/lib/storage/media";

export const dynamic = "force-dynamic";

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
};

const IMMUTABLE = "public, max-age=31536000, immutable";
const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate", "CDN-Cache-Control": "no-store" };

function imageResponse(buffer: Buffer, relPath: string, etag: string): NextResponse {
  const ext = path.extname(relPath).toLowerCase();
  const contentType = MIME_BY_EXT[ext] || "application/octet-stream";
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(buffer.length),
      "Cache-Control": IMMUTABLE,
      ETag: etag,
    },
  });
}

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

  // Volume first (unchanged fast path for every current file).
  try {
    const fileStat = await stat(full);
    if (fileStat.isFile()) {
      const buffer = await readFile(full);
      // mtime+size weak ETag — filenames are content-addressed so stable.
      const etag = `"${fileStat.size}-${fileStat.mtimeMs.toString(16)}"`;
      return imageResponse(buffer, relPath, etag);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    // ENOENT → fall through to the R2 read-through below.
  }

  // Read-through: a file that lives only on R2 (migrated, or written after
  // a cutover) still serves through this same stable URL.
  const r2Bytes = await readFromR2IfPresent(`images/${relPath}`);
  if (r2Bytes) {
    const etag = `"r2-${r2Bytes.length.toString(16)}"`;
    return imageResponse(r2Bytes, relPath, etag);
  }

  return new NextResponse("Not found", { status: 404, headers: NO_STORE });
}
