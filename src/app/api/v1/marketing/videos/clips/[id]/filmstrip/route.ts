/**
 * GET /api/v1/marketing/videos/clips/[id]/filmstrip
 *
 * One wide JPEG of evenly-spaced thumbnails across the clip, sized to sit
 * behind the splitter's timeline. Seeing where the shot changes beats
 * scrubbing to find them, and it makes the scene-cut markers legible
 * rather than abstract.
 *
 * Built once and cached on the volume next to the clip's poster — a
 * filmstrip is deterministic for a given clip, so it never needs redoing.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { buildFilmstrip } from "@/modules/marketing/lib/video/filmstrip";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { url, tiles } = await buildFilmstrip(id);
    return NextResponse.json({ url, tiles });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = /not found/i.test(message) ? 404 : /no video|duration/i.test(message) ? 400 : 500;
    if (status === 500) console.error("[filmstrip] failed:", e);
    return NextResponse.json({ error: message }, { status });
  }
}
