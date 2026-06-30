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
    async?: boolean;
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

  // For batches > 100, Cloudflare's ~100s edge timeout will 524 the
  // HTTP response even though Node keeps executing. Default to
  // fire-and-forget for big batches so the caller gets a clean 200
  // and can monitor progress via the cohort-needing-phone-enrichment
  // endpoint.
  const asyncRequested = body.async === true;
  const asyncMode = asyncRequested || (limit > 100 && body.async !== false);

  if (asyncMode) {
    // Dispatch without awaiting — the work continues in the Node
    // process while we return immediately. Any error gets logged
    // but doesn't crash the request.
    void enrichViaGoogleMaps({
      limit,
      tier,
      status,
      force: body.force === true,
      dryRun: body.dryRun === true,
    })
      .then((r) => {
        console.log(
          `[enrich-via-apify] dispatched batch completed: ` +
            `attempted=${r.companies_attempted} ` +
            `phones=${r.phones_added} closed=${r.permanently_closed_marked} ` +
            `no_match=${r.no_match} low_conf=${r.low_confidence_skipped} ` +
            `errors=${r.errors.length}`,
        );
      })
      .catch((e) => {
        console.error(
          `[enrich-via-apify] dispatched batch threw:`,
          e instanceof Error ? e.message : String(e),
        );
      });

    return NextResponse.json({
      ok: true,
      dispatched: true,
      message:
        `Enrichment dispatched in the background for up to ${limit} companies. ` +
        `Poll GET /api/admin/sales/cohort-needing-phone-enrichment to watch ` +
        `the cohort shrink as phones are added, or check Railway logs for the ` +
        `final '[enrich-via-apify] dispatched batch completed' line.`,
      estimated_runtime_seconds: Math.ceil(limit / 25) * 60,
    });
  }

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
