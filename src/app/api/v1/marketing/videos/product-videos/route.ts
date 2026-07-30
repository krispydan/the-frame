/**
 * Product videos — one canonical video per parent frame.
 *
 *   GET                        → every built product video
 *   POST { productId }         → build (or rebuild) one, synchronously
 *   POST { all: true }         → queue a build for every READY product
 *   PATCH { productId, approved } → the human gate before publishing
 *   PATCH { productId, caption }  → hand-edit the PDP line
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { jobQueue } from "@/modules/core/lib/job-queue";
import {
  buildProductVideo,
  listProductVideos,
  generateProductCaption,
  setApproved,
} from "@/modules/marketing/lib/video/product-video";
import { buildProductCoverage } from "@/modules/marketing/lib/video/product-coverage";

export async function GET() {
  return NextResponse.json({ videos: listProductVideos() });
}

export async function POST(request: NextRequest) {
  let body: { productId?: unknown; all?: unknown; withCaption?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    /* defaults */
  }

  // Batch: queue every product whose footage can actually make a video.
  if (body.all === true) {
    const ready = buildProductCoverage().products.filter((p) => p.status === "ready");
    if (ready.length === 0) {
      return NextResponse.json({ queued: false, message: "No products have enough footage yet" });
    }
    const jobId = jobQueue.enqueue(
      "marketing.video.build-product-videos",
      "marketing",
      { productIds: ready.map((p) => p.productId) },
      { priority: 3 },
    );
    return NextResponse.json({ queued: true, total: ready.length, jobId });
  }

  const productId = typeof body.productId === "string" ? body.productId : "";
  if (!productId) return NextResponse.json({ error: "productId required" }, { status: 400 });

  try {
    const result = await buildProductVideo(productId);
    if (!result.ok) {
      return NextResponse.json({ error: `Can't build: ${result.reason}`, ...result }, { status: 422 });
    }
    // Best-effort caption — a failure leaves a usable video.
    if (body.withCaption !== false) await generateProductCaption(productId).catch(() => {});
    const video = listProductVideos().find((v) => v.productId === productId);
    return NextResponse.json({ video });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[product-video] build failed:", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  let body: { productId?: unknown; approved?: unknown; caption?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  const productId = typeof body.productId === "string" ? body.productId : "";
  if (!productId) return NextResponse.json({ error: "productId required" }, { status: 400 });

  if (body.caption !== undefined) {
    sqlite
      .prepare(`UPDATE marketing_product_videos SET caption = ?, updated_at = datetime('now') WHERE product_id = ?`)
      .run(String(body.caption), productId);
  }
  if (body.approved !== undefined) {
    const ok = setApproved(productId, Boolean(body.approved));
    if (!ok) return NextResponse.json({ error: "Only a rendered video can be approved" }, { status: 409 });
  }
  return NextResponse.json({ video: listProductVideos().find((v) => v.productId === productId) });
}
