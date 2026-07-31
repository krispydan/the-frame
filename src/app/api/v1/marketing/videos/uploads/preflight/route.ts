/**
 * POST /api/v1/marketing/videos/uploads/preflight
 *
 * Body: { files: [{ fileName, sizeBytes }] }
 * Response: { results: PreflightResult[], summary }
 *
 * Called by the uploader BEFORE any bytes move, so re-dropping a whole
 * shoot folder only uploads what's genuinely new. Purely advisory: the
 * checksum gate at /register is still what guarantees nothing is stored
 * twice.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { preflightFiles, type PreflightFile } from "@/modules/marketing/lib/video/upload-preflight";

/** One drag of a big shoot folder — generous, but bounded. */
const MAX_FILES = 1000;

export async function POST(request: NextRequest) {
  let body: { files?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body.files)) {
    return NextResponse.json({ error: "files must be an array" }, { status: 400 });
  }
  if (body.files.length > MAX_FILES) {
    return NextResponse.json({ error: `Too many files (max ${MAX_FILES})` }, { status: 413 });
  }

  const files: PreflightFile[] = body.files.map((f) => {
    const rec = (f ?? {}) as Record<string, unknown>;
    return {
      fileName: typeof rec.fileName === "string" ? rec.fileName : "",
      sizeBytes: Number(rec.sizeBytes) || 0,
    };
  });

  try {
    const result = await preflightFiles(files);
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[upload preflight] failed:", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
