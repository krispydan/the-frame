/**
 * POST /api/v1/marketing/videos/product-videos/faire
 * Body: { productId }
 *
 * Prepares an APPROVED product video for Faire and marks it exported.
 * Faire's API has no product-video upload endpoint (images only), so this
 * returns the exact file + caption to drop into the brand portal.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { exportProductVideoForFaire } from "@/modules/marketing/lib/video/product-video-faire";

export async function POST(request: NextRequest) {
  let body: { productId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  const productId = typeof body.productId === "string" ? body.productId : "";
  if (!productId) return NextResponse.json({ error: "productId required" }, { status: 400 });

  const result = exportProductVideoForFaire(productId);
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}
