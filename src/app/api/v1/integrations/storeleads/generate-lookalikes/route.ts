export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import {
  generateLookalikes,
  mergeLookalikesIntoCompanies,
} from "@/modules/sales/lib/storeleads/lookalike-audience";

/**
 * POST /api/v1/integrations/storeleads/generate-lookalikes
 *
 * Aggregates our enriched customers' StoreLeads attributes (categories,
 * platform, country, sales bands) into a search profile, then hits
 * StoreLeads' List Domains endpoint per top category to surface new
 * prospects that match.
 *
 * Body (all optional):
 *   {
 *     topCategoriesToTarget?: 3,
 *     maxResults?: 500,
 *     countryFilter?: "US",
 *     platformFilter?: "shopify",
 *     minYearlySalesCents?: 10000000,
 *     dryRun?: true       // run the search, return results, don't upsert
 *   }
 *
 * Returns the aggregated profile + raw search results + per-category
 * counts. When dryRun is false (default), also upserts into companies
 * with source_type='storeleads', source='storeleads_lookalike:<seed>'.
 */
export async function POST(req: NextRequest) {
  let body: {
    topCategoriesToTarget?: number;
    maxResults?: number;
    countryFilter?: string;
    platformFilter?: string;
    minYearlySalesCents?: number;
    dryRun?: boolean;
  } = {};
  try {
    body = await req.json();
  } catch {
    // empty body fine
  }

  try {
    const run = await generateLookalikes({
      topCategoriesToTarget: body.topCategoriesToTarget,
      maxResults: body.maxResults,
      countryFilter: body.countryFilter,
      platformFilter: body.platformFilter,
      minYearlySalesCents: body.minYearlySalesCents,
    });

    if (body.dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        profile: run.profile,
        effectiveFilters: run.effectiveFilters,
        results: run.results.slice(0, 50),
        resultCount: run.results.length,
        perCategory: run.perCategory,
        errors: run.errors,
        durationMs: run.durationMs,
      });
    }

    const mergeStats = mergeLookalikesIntoCompanies({
      results: run.results,
      sourceLabel: "storeleads_lookalike",
    });

    return NextResponse.json({
      ok: true,
      profile: run.profile,
      effectiveFilters: run.effectiveFilters,
      resultCount: run.results.length,
      perCategory: run.perCategory,
      merge: mergeStats,
      errors: run.errors,
      durationMs: run.durationMs,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
