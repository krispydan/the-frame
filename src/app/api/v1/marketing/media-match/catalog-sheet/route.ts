/**
 * /api/v1/marketing/media-match/catalog-sheet
 *
 * GET — the labelled product reference fed to the frame-shape AI (one
 * image per product, each preceded by "#N — Name (SKU)"), so the exact
 * catalog input can be inspected. Cached by catalog signature.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { catalogReferenceForDisplay } from "@/modules/marketing/lib/video/frame-shape-sheet";

export async function GET() {
  try {
    return NextResponse.json(await catalogReferenceForDisplay());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
