/**
 * POST /api/v1/marketing/videos/clips/[id]/renormalize
 *
 * Re-enqueue the normalization job for a clip — used after a failed
 * normalize or a normalization-profile bump. Clears the failed state.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { videoClips } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { jobQueue } from "@/modules/core/lib/job-queue";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const clip = db.select().from(videoClips).where(eq(videoClips.id, id)).get();
  if (!clip) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (clip.status === "normalizing") {
    return NextResponse.json({ error: "Already normalizing" }, { status: 409 });
  }

  db.update(videoClips)
    .set({ status: "uploaded", error: null, updatedAt: new Date().toISOString() })
    .where(eq(videoClips.id, id))
    .run();
  const jobId = jobQueue.enqueue("marketing.video.normalize-clip", "marketing", { clipId: id }, { priority: 2 });

  return NextResponse.json({ enqueued: true, jobId });
}
