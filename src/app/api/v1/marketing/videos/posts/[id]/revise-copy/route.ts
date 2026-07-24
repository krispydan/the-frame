/**
 * POST /api/v1/marketing/videos/posts/[id]/revise-copy
 *
 * Body: { feedback: string } — natural-language ask to improve the
 * post's caption / hashtags / posting instructions (same pattern as the
 * email editor's revise-copy). Revises from the CURRENT copy so the
 * operator can iterate conversationally. No fallback: a failed AI call
 * leaves the copy untouched and returns the error.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { videoPosts } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { reviseVideoCopy } from "@/modules/marketing/lib/video/video-ai";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: { feedback?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";
  if (!feedback) return NextResponse.json({ error: "feedback required" }, { status: 400 });

  const post = db.select().from(videoPosts).where(eq(videoPosts.id, id)).get();
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const result = await reviseVideoCopy(id, feedback);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[video revise-copy] unhandled:", e);
    return NextResponse.json({ error: `Server error: ${message}` }, { status: 500 });
  }
}
