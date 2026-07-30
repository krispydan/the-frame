/**
 * POST /api/v1/marketing/videos/product-videos/publish
 * Body: { productId }
 *
 * Pushes an APPROVED product video to its Shopify product page. Approval
 * is enforced in the lib, not here — nothing reaches the storefront
 * without a human having clicked approve.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { publishProductVideo } from "@/modules/marketing/lib/video/product-video-publish";

export async function POST(request: NextRequest) {
  let body: { productId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  const productId = typeof body.productId === "string" ? body.productId : "";
  if (!productId) return NextResponse.json({ error: "productId required" }, { status: 400 });

  try {
    const result = await publishProductVideo(productId);
    if (!result.ok) return NextResponse.json(result, { status: 422 });
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[product-video publish] failed:", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
