export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import type { CompanyForClassification } from "@/modules/sales/lib/llm-prompt";

/**
 * GET /api/v1/sales/prospects/unclassified
 *
 * Paginated batch of prospects that need LLM classification. Used by the
 * Mac-mini classifier worker.
 *
 * Auth: header `X-Classifier-Token: <CLASSIFIER_TOKEN>` matching the
 * server-side env var. Path is allowlisted in middleware so it skips the
 * session cookie check.
 *
 * Query params:
 *   limit  — batch size (default 50, max 100)
 *   cursor — last-seen id from prior batch; SQL pages with id > cursor
 *   include_stale_enrichment — if "true", also include rows where
 *           enrichment_fetched_at < (now - 90 days)
 *
 * Selection criteria:
 *   - country IS NULL or country = "US"
 *   - status != "rejected"
 *   - industry IS NULL or industry = "unclassified"
 *   - icp_manual_override != true   (don't re-classify human-locked rows)
 */
export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Invalid X-Classifier-Token" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const limit = Math.min(parseInt(sp.get("limit") || "50"), 100);
  const cursor = sp.get("cursor");
  const includeStale = sp.get("include_stale_enrichment") === "true";

  // Build the SELECT — paginate by id (UUIDs sort lexicographically)
  const where: string[] = [
    "(country IS NULL OR upper(country) = 'US')",
    "status != 'rejected'",
    "(icp_manual_override IS NULL OR icp_manual_override = 0)",
  ];
  const params: unknown[] = [];

  if (includeStale) {
    where.push(`(
      industry IS NULL OR industry = 'unclassified'
      OR enrichment_fetched_at IS NULL
      OR enrichment_fetched_at < datetime('now', '-90 days')
    )`);
  } else {
    where.push("(industry IS NULL OR industry = 'unclassified')");
  }

  if (cursor) {
    where.push("id > ?");
    params.push(cursor);
  }

  const whereSql = where.join(" AND ");

  // Pull the columns we actually need; keep payload small
  const rows = sqlite.prepare(`
    SELECT
      c.id, c.name, c.city, c.state, c.country, c.website, c.tags,
      c.category, c.google_rating, c.google_review_count,
      c.instagram_url, c.facebook_url, c.industry, c.enrichment_text,
      c.enrichment_source, c.enrichment_fetched_at
    FROM companies c
    WHERE ${whereSql}
    ORDER BY c.id ASC
    LIMIT ?
  `).all(...params, limit) as Array<{
    id: string;
    name: string;
    city: string | null;
    state: string | null;
    country: string | null;
    website: string | null;
    tags: string | null;
    category: string | null;
    google_rating: number | null;
    google_review_count: number | null;
    instagram_url: string | null;
    facebook_url: string | null;
    industry: string | null;
    enrichment_text: string | null;
    enrichment_source: string | null;
    enrichment_fetched_at: string | null;
  }>;

  // Total remaining (cheap count without LIMIT)
  const totalRow = sqlite.prepare(`
    SELECT COUNT(*) AS c FROM companies c WHERE ${whereSql.replace(/ AND id > \?$/, "")}
  `).get(...params.filter((_, i) => i < params.length - (cursor ? 1 : 0))) as { c: number };

  const batch: (CompanyForClassification & {
    enrichment_text: string | null;
    enrichment_source: string | null;
    enrichment_fetched_at: string | null;
  })[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    city: r.city,
    state: r.state,
    country: r.country,
    website: r.website,
    tags: r.tags ? safeJsonArray(r.tags) : [],
    category: r.category,
    google_rating: r.google_rating,
    google_review_count: r.google_review_count,
    instagram_url: r.instagram_url,
    facebook_url: r.facebook_url,
    industry: r.industry,
    enrichment_text: r.enrichment_text,
    enrichment_source: r.enrichment_source,
    enrichment_fetched_at: r.enrichment_fetched_at,
  }));

  return NextResponse.json({
    batch,
    next_cursor: batch.length === limit ? batch[batch.length - 1].id : null,
    remaining: totalRow.c,
  });
}

function checkAuth(req: NextRequest): boolean {
  const provided = req.headers.get("x-classifier-token");
  const expected = process.env.CLASSIFIER_TOKEN;
  if (!expected) {
    console.error("[unclassified] CLASSIFIER_TOKEN env var not set on server");
    return false;
  }
  return !!provided && provided === expected;
}

function safeJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
