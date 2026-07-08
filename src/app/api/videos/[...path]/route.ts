/**
 * Public video-serving route.
 *
 * GET /api/videos/<...path>  →  raw file from VIDEOS_ROOT
 *
 * Like /api/images/[...path] but with HTTP Range support so <video>
 * elements can stream + scrub renders in the post queue UI without
 * downloading the whole file.
 *
 * Responses are immutable (paths are content/ID-addressed) so we cache
 * aggressively: Cache-Control: public, max-age=31536000, immutable.
 *
 * Path traversal is blocked by getVideoFullPath() in src/lib/storage/videos.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { stat, open } from "fs/promises";
import path from "path";
import { getVideoFullPath, videoUrl } from "@/lib/storage/videos";
import { mediaOnR2 } from "@/lib/storage/media";

export const dynamic = "force-dynamic";

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".txt": "text/plain",
};

const NOT_FOUND_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "CDN-Cache-Control": "no-store",
};

async function readSlice(full: string, start: number, end: number): Promise<Buffer> {
  const fh = await open(full, "r");
  try {
    const length = end - start + 1;
    const buffer = Buffer.alloc(length);
    await fh.read(buffer, 0, length, start);
    return buffer;
  } finally {
    await fh.close();
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await params;
  if (!segments || segments.length === 0) {
    return new NextResponse("Not found", { status: 404 });
  }

  const relPath = segments.map((s) => decodeURIComponent(s)).join("/");

  // When R2 is live, the bytes live on the CDN, not this volume. Redirect
  // any lingering /api/videos links (old DB rows, cached pages) to the
  // public R2 URL instead of 404-ing on an empty volume.
  if (mediaOnR2()) {
    const u = videoUrl(relPath);
    if (/^https?:\/\//.test(u)) {
      return NextResponse.redirect(u, 302);
    }
  }

  let full: string;
  try {
    full = getVideoFullPath(relPath);
  } catch {
    return new NextResponse("Forbidden", { status: 403 });
  }

  let fileStat;
  try {
    fileStat = await stat(full);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return new NextResponse("Not found", { status: 404, headers: NOT_FOUND_HEADERS });
    }
    throw err;
  }
  if (!fileStat.isFile()) {
    return new NextResponse("Not found", { status: 404, headers: NOT_FOUND_HEADERS });
  }

  const ext = path.extname(full).toLowerCase();
  const contentType = MIME_BY_EXT[ext] || "application/octet-stream";
  const etag = `"${fileStat.size}-${fileStat.mtimeMs.toString(16)}"`;
  const size = fileStat.size;

  const baseHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: etag,
  };

  // ── Range request (video scrubbing) ──
  const rangeHeader = request.headers.get("range");
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match || (match[1] === "" && match[2] === "")) {
      return new NextResponse("Malformed Range", {
        status: 416,
        headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
      });
    }
    // bytes=start-end | bytes=start- | bytes=-suffixLength
    let start: number;
    let end: number;
    if (match[1] === "") {
      const suffix = Math.min(parseInt(match[2], 10), size);
      start = size - suffix;
      end = size - 1;
    } else {
      start = parseInt(match[1], 10);
      end = match[2] === "" ? size - 1 : Math.min(parseInt(match[2], 10), size - 1);
    }
    if (start > end || start >= size) {
      return new NextResponse("Range Not Satisfiable", {
        status: 416,
        headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
      });
    }

    const slice = await readSlice(full, start, end);
    return new NextResponse(new Uint8Array(slice), {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(slice.length),
      },
    });
  }

  // ── Full response ──
  const buffer = await readSlice(full, 0, size - 1);
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(buffer.length) },
  });
}
