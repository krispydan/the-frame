export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { enrichViaGoogleMaps } from "@/modules/sales/lib/google-maps-enrichment";

/**
 * POST /api/admin/sales/enrich-via-apify
 *
 * Enriches a batch of qualified-but-no-phone companies via the Apify
 * Google Maps Scraper actor. For each company, looks up the matching
 * place by name+city+state, then writes:
 *   - phone → company_phones (for Sandra to call)
 *   - hours → companies.business_hours
 *   - rating/reviews → google_rating / google_review_count
 *   - permanently_closed → status = 'not_qualified'
 *   - place_id → companies.google_place_id (prevents re-query)
 *
 * Body:
 *   { limit?: number,         default 50, max 500
 *     tier?: "A" | "A,B" |…   ICP tier filter, comma-separated
 *     status?: "qualified,…"  pipeline-status filter
 *     force?: boolean         re-query companies that already have
 *                              a google_place_id (default false)
 *     dryRun?: boolean        return cohort size only, no API calls
 *   }
 *
 * Returns the EnrichmentResult counts. maxDuration=600 since each
 * Apify batch of 25 places takes ~30-90s and the function may
 * process several batches.
 *
 * Cost: ~$2-3 per 1000 places at Apify's per-CU pricing.
 *
 * Auth: x-admin-key.
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: {
    limit?: number;
    tier?: string;
    status?: string;
    force?: boolean;
    dryRun?: boolean;
  } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body fine — uses defaults */
  }

  const limit = Math.min(500, Math.max(1, body.limit ?? 50));
  const tier = body.tier
    ? body.tier.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : undefined;
  const status = body.status
    ? body.status.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  try {
    const result = await enrichViaGoogleMaps({
      limit,
      tier,
      status,
      force: body.force === true,
      dryRun: body.dryRun === true,
    });
    return NextResponse.json({
      ok: true,
      dry_run: body.dryRun === true,
      ...result,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: 500 },
    );
  }
}
