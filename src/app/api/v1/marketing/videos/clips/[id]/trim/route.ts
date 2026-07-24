/**
 * POST /api/v1/marketing/videos/clips/[id]/trim
 *
 * Body: { startSec: number, endSec: number }
 * Cuts a new clip out of this one (new in/out points). The original is
 * untouched; the trimmed clip is normalized synchronously and returned
 * READY, so the caller can immediately swap it into a post's sequence.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { trimClip } from "@/modules/marketing/lib/video/trim";
import { videoUrl } from "@/lib/storage/videos";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { startSec?: unknown; endSec?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }

  try {
    const { clip, deduped } = await trimClip(id, Number(body.startSec), Number(body.endSec));
    const category = clip.categoryId
      ? (sqlite.prepare(`SELECT slug FROM marketing_video_clip_categories WHERE id = ?`).get(clip.categoryId) as
          | { slug: string }
          | undefined)?.slug
      : null;
    return NextResponse.json({
      deduped,
      clip: {
        id: clip.id,
        fileName: clip.fileName,
        durationSec: clip.durationSec,
        status: clip.status,
        posterUrl: clip.posterPath ? videoUrl(clip.posterPath) : null,
        previewUrl: clip.normalizedPath ? videoUrl(clip.normalizedPath) : null,
        category: category ?? null,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = /not found/i.test(message) ? 404 : /must be|is past|required|no video/i.test(message) ? 400 : 500;
    if (status === 500) console.error("[trim] failed:", e);
    return NextResponse.json({ error: message }, { status });
  }
}
