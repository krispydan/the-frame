/**
 * GET  /api/v1/marketing/videos/clips/[id]/split
 *      → scene cuts + pre-placed segments to adjust. ?force=1 re-detects.
 *
 * POST /api/v1/marketing/videos/clips/[id]/split
 *      Body: { segments: [{startSec,endSec}], parentAction?: "archive"|"keep" }
 *          | { dismiss: true }   — "this length is fine", leaves the queue
 *      → enqueues the cut and returns a jobId to poll.
 *
 * The cut is a job because each segment re-encodes and normalizes; the
 * reviewer moves on to the next clip while it runs.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { jobQueue } from "@/modules/core/lib/job-queue";
import {
  suggestSplit,
  markReviewed,
  MIN_SEGMENT_SEC,
} from "@/modules/marketing/lib/video/split-review";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    return NextResponse.json(await suggestSplit(id, request.nextUrl.searchParams.get("force") === "1"));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = /not found/i.test(message) ? 404 : /no video|no known duration/i.test(message) ? 400 : 500;
    if (status === 500) console.error("[split suggest] failed:", e);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const { id } = await params;
  let body: { segments?: unknown; parentAction?: unknown; dismiss?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }

  // "It's fine as it is" — out of the queue without cutting anything.
  if (body.dismiss === true) {
    markReviewed([id]);
    return NextResponse.json({ dismissed: true });
  }

  if (!Array.isArray(body.segments) || body.segments.length === 0) {
    return NextResponse.json({ error: "segments required" }, { status: 400 });
  }

  const segments = body.segments
    .map((s) => (s ?? {}) as Record<string, unknown>)
    .map((s) => ({ startSec: Number(s.startSec), endSec: Number(s.endSec) }))
    .filter((s) => Number.isFinite(s.startSec) && Number.isFinite(s.endSec));

  if (segments.length === 0) {
    return NextResponse.json({ error: "No valid segments" }, { status: 400 });
  }
  const tooShort = segments.find((s) => s.endSec - s.startSec < MIN_SEGMENT_SEC);
  if (tooShort) {
    return NextResponse.json(
      { error: `Every segment must be at least ${MIN_SEGMENT_SEC}s (${tooShort.startSec}s–${tooShort.endSec}s isn't)` },
      { status: 400 },
    );
  }

  const jobId = jobQueue.enqueue(
    "marketing.video.split-clip",
    "marketing",
    { clipId: id, segments, parentAction: body.parentAction === "keep" ? "keep" : "archive" },
    { priority: 1 },
  );

  return NextResponse.json({ jobId, queued: segments.length }, { status: 202 });
}
