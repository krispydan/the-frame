/**
 * POST /api/v1/marketing/videos/clips/[id]/transform
 *
 * Body: a ClipTransform —
 *   { kind: "reframe", zoom: number, x: number, y: number }
 *   { kind: "punch" }
 *   { kind: "speed", factor: number }
 *
 * Applies a visual effect to this clip, producing a NEW ready clip (the
 * original is untouched). The trimmed/transformed clip is normalized
 * synchronously and returned so the caller can swap it into a sequence.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { transformClip, type ClipTransform } from "@/modules/marketing/lib/video/transform";
import { videoUrl } from "@/lib/storage/videos";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }

  const kind = body.kind;
  let transform: ClipTransform;
  if (kind === "reframe") {
    transform = { kind: "reframe", zoom: Number(body.zoom), x: Number(body.x), y: Number(body.y) };
  } else if (kind === "punch") {
    transform = { kind: "punch" };
  } else if (kind === "speed") {
    transform = { kind: "speed", factor: Number(body.factor) };
  } else {
    return NextResponse.json({ error: "kind must be reframe, punch or speed" }, { status: 400 });
  }

  try {
    const { clip, deduped } = await transformClip(id, transform);
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
    const status = /not found/i.test(message) ? 404 : /must be|required|no video|positive|greater/i.test(message) ? 400 : 500;
    if (status === 500) console.error("[transform] failed:", e);
    return NextResponse.json({ error: message }, { status });
  }
}
