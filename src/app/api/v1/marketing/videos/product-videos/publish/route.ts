/**
 * POST /api/v1/marketing/videos/product-videos/publish
 * Body: { productId, channels?: ("retail"|"wholesale")[] }
 *
 * Pushes an APPROVED product video to the product page on BOTH Shopify
 * stores by default. Approval is enforced in the lib, not here — nothing
 * reaches a storefront without a human having clicked approve.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import {
  publishProductVideo,
  SHOPIFY_CHANNELS,
  type ShopifyChannel,
} from "@/modules/marketing/lib/video/product-video-publish";

export async function POST(request: NextRequest) {
  let body: { productId?: unknown; channels?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  const productId = typeof body.productId === "string" ? body.productId : "";
  if (!productId) return NextResponse.json({ error: "productId required" }, { status: 400 });

  // Default: publish to every store.
  const channels = Array.isArray(body.channels)
    ? (body.channels.map(String).filter((c): c is ShopifyChannel => SHOPIFY_CHANNELS.includes(c as ShopifyChannel)))
    : SHOPIFY_CHANNELS;
  if (channels.length === 0) {
    return NextResponse.json({ error: "channels must include retail and/or wholesale" }, { status: 400 });
  }

  try {
    const result = await publishProductVideo(productId, channels);
    if (!result.ok) return NextResponse.json(result, { status: 422 });
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[product-video publish] failed:", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
