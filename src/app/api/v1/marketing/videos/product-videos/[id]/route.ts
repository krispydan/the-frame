/**
 * One product's video — the edit page's endpoint.
 *
 *   GET   → the video, its clip sequence, and every other clip of this
 *           product that could be added
 *   PATCH → { clipIds } rebuild from a hand-edited sequence
 *           { caption } edit the PDP line
 *           { approved } the publish gate
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import {
  getProductVideo,
  buildProductVideo,
  generateProductCaption,
  setApproved,
  listProductVideos,
} from "@/modules/marketing/lib/video/product-video";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const detail = getProductVideo(id);
  if (!detail) return NextResponse.json({ error: "Product not found" }, { status: 404 });
  return NextResponse.json(detail);
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  let body: { clipIds?: unknown; caption?: unknown; approved?: unknown; regenerateCaption?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }

  // Rebuild from a hand-edited sequence.
  if (Array.isArray(body.clipIds)) {
    const clipIds = body.clipIds.map(String);
    if (clipIds.length === 0) return NextResponse.json({ error: "Pick at least one clip" }, { status: 400 });
    try {
      const result = await buildProductVideo(id, clipIds);
      if (!result.ok) return NextResponse.json({ error: `Can't build: ${result.reason}` }, { status: 422 });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[product-video] rebuild failed:", e);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  if (body.caption !== undefined) {
    sqlite
      .prepare(`UPDATE marketing_product_videos SET caption = ?, updated_at = datetime('now') WHERE product_id = ?`)
      .run(String(body.caption), id);
  }
  if (body.regenerateCaption === true) {
    await generateProductCaption(id).catch(() => {});
  }
  if (body.approved !== undefined) {
    const ok = setApproved(id, Boolean(body.approved));
    if (!ok) return NextResponse.json({ error: "Only a rendered video can be approved" }, { status: 409 });
  }

  const detail = getProductVideo(id);
  return NextResponse.json(detail ?? { video: listProductVideos().find((v) => v.productId === id) });
}
