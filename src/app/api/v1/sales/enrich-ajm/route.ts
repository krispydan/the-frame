export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { enrichViaGoogleMaps } from "@/modules/sales/lib/google-maps-enrichment";

/**
 * POST /api/v1/sales/enrich-ajm   (logged-in)
 *
 * Enrich the AJM cohort (companies tagged ajm_2025 / source ajm_2025_import)
 * via the Apify Google Maps scraper: website, business hours, rating, and
 * permanently-closed detection. Batched by the caller (small limit per call)
 * so it stays under the edge timeout.
 *
 * Body: { limit?: number (default 25, max 100), force?: boolean, dryRun?: boolean }
 */
export async function POST(req: NextRequest) {
  let body: { limit?: number; force?: boolean; dryRun?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* defaults */
  }
  const limit = Math.min(100, Math.max(1, body.limit ?? 25));
  try {
    const result = await enrichViaGoogleMaps({
      ajm: true,
      limit,
      force: body.force === true,
      dryRun: body.dryRun === true,
    });
    return NextResponse.json({ ok: true, dryRun: body.dryRun === true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
