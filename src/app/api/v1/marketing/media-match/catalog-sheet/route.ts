/**
 * /api/v1/marketing/media-match/catalog-sheet
 *
 * GET — the numbered product contact sheet(s) fed to the frame-shape AI,
 * so the exact catalog reference can be inspected. Returns served page
 * URLs (built once, cached by catalog signature).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { contactSheetUrls } from "@/modules/marketing/lib/video/frame-shape-sheet";

export async function GET() {
  try {
    return NextResponse.json(await contactSheetUrls());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
