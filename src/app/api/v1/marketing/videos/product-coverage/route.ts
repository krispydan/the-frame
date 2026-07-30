/**
 * GET /api/v1/marketing/videos/product-coverage
 *
 * Per-product footage coverage for the product-video programme: which of
 * the parent frames can generate a video today (ready), which need one
 * more shot (thin), and which have nothing filmed (no_footage).
 */
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { buildProductCoverage } from "@/modules/marketing/lib/video/product-coverage";

export async function GET() {
  return NextResponse.json(buildProductCoverage());
}
