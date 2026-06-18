export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { companies, stores, contacts } from "@/modules/sales/schema";
import { eq, sql, and, inArray, gte, lte, isNotNull, like, desc, asc } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const page = Math.max(1, parseInt(params.get("page") || "1"));
  const limit = Math.min(100, Math.max(1, parseInt(params.get("limit") || "25")));
  const search = params.get("search")?.trim();
  const sort = params.get("sort") || "name";
  const order = params.get("order") === "desc" ? "DESC" : "ASC";
  
  // Filters
  const stateFilter = params.getAll("state");
  const industryFilter = params.getAll("industry");      // NEW: curated bucket
  const categoryFilter = params.getAll("category");      // DEPRECATED: kept for backwards compat with bookmarked URLs
  const sourceFilter = params.getAll("source");
  const statusFilter = params.getAll("status");
  const icpMin = params.get("icp_min");
  const icpMax = params.get("icp_max");
  const hasEmail = params.get("has_email");
  const hasPhone = params.get("has_phone");
  const sourceTypeFilter = params.getAll("source_type");
  const segmentFilter = params.getAll("segment");
  // source_query filter — exact match. Used by the eyewear smart
  // lists to slice by crawl cohort ("eyewear_inventory_v1_2026-06"
  // vs "apparel_no_eyewear_v1_2026-06") without polluting tags.
  const sourceQueryFilter = params.getAll("source_query");
  // tag_and: every value must appear in c.tags (AND semantics).
  // tag_not: none of these values may appear in c.tags.
  // Distinct from `category` which is legacy OR semantics. Used by
  // the eyewear "Pitchable" smart list which needs
  //   eyewear_cohort AND (entry OR mid) AND multi_brand AND NOT too_high
  const tagAndFilter = params.getAll("tag_and");
  const tagNotFilter = params.getAll("tag_not");
  // source_id filter dropped — 32K+ near-unique values made it useless.

  const offset = (page - 1) * limit;
  // `ids_only=1` returns just the matching company IDs (up to 50k) so the
  // client can resolve "select all matching" → full ID list for a bulk
  // action without transferring 4k rows of joined data. Skips the count
  // query, joins, and pagination since the caller wants the full set.
  const idsOnly = params.get("ids_only") === "1";

  // Build WHERE clauses
  const whereClauses: string[] = [];
  const whereParams: unknown[] = [];

  // Search routing:
  //   - Email-shaped queries (contain @) → direct LIKE on email. The
  //     companies_fts index doesn't include email, and FTS5's default
  //     tokenizer splits on @ and . anyway, so neither path works for
  //     email lookups. LIKE is slow on 130K rows (~300ms) but it works.
  //   - Everything else → FTS5 with prefix match.
  let ftsRowIds: number[] | null = null;
  if (search) {
    if (search.includes("@")) {
      whereClauses.push(`LOWER(c.email) LIKE ?`);
      whereParams.push(`%${search.toLowerCase()}%`);
    } else {
      try {
        const ftsResults = sqlite.prepare(`
          SELECT rowid FROM companies_fts WHERE companies_fts MATCH ? LIMIT 10000
        `).all(search + "*") as { rowid: number }[];
        ftsRowIds = ftsResults.map(r => r.rowid);
        // If FTS finds nothing, also try LIKE on email as a fallback —
        // catches partial-email queries like "theebossylook2024" without
        // the @-domain part.
        if (ftsRowIds.length === 0) {
          whereClauses.push(`(c.name LIKE ? OR LOWER(c.email) LIKE ?)`);
          whereParams.push(`%${search}%`, `%${search.toLowerCase()}%`);
        } else {
          whereClauses.push(`c.rowid IN (${ftsRowIds.join(",")})`);
        }
      } catch {
        // FTS query syntax error (rare) → LIKE on name + email
        whereClauses.push(`(c.name LIKE ? OR LOWER(c.email) LIKE ?)`);
        whereParams.push(`%${search}%`, `%${search.toLowerCase()}%`);
      }
    }
  }

  if (stateFilter.length > 0) {
    whereClauses.push(`c.state IN (${stateFilter.map(() => "?").join(",")})`);
    whereParams.push(...stateFilter);
  }

  // Industry filter — uses the curated bucket column populated by the
  // industry-mapping backfill. Replaces the old tags-LIKE category filter
  // (which was unreliable + slow).
  if (industryFilter.length > 0) {
    whereClauses.push(`c.industry IN (${industryFilter.map(() => "?").join(",")})`);
    whereParams.push(...industryFilter);
  } else {
    // Default view: hide out_of_scope rows so the list shows actual ICP.
    // Caller can pass industry=out_of_scope explicitly to see them.
    whereClauses.push(`(c.industry IS NULL OR c.industry != 'out_of_scope')`);
  }

  // Legacy category filter (tag-based). Only honored if someone bookmarked
  // an old URL — new UI doesn't generate this.
  if (categoryFilter.length > 0) {
    const catConditions = categoryFilter.map(() => `c.tags LIKE ?`);
    whereClauses.push(`(${catConditions.join(" OR ")})`);
    whereParams.push(...categoryFilter.map(c => `%${c}%`));
  }

  if (sourceFilter.length > 0) {
    const srcConditions = sourceFilter.map(() => `c.source LIKE ?`);
    whereClauses.push(`(${srcConditions.join(" OR ")})`);
    whereParams.push(...sourceFilter.map(s => `%${s}%`));
  }

  if (statusFilter.length > 0) {
    whereClauses.push(`c.status IN (${statusFilter.map(() => "?").join(",")})`);
    whereParams.push(...statusFilter);
  } else {
    // Default: exclude rejected/not-qualified prospects
    whereClauses.push(`c.status != 'rejected'`);
  }

  if (icpMin) {
    whereClauses.push(`c.icp_score >= ?`);
    whereParams.push(parseInt(icpMin));
  }
  if (icpMax) {
    whereClauses.push(`c.icp_score <= ?`);
    whereParams.push(parseInt(icpMax));
  }

  if (hasEmail === "true") {
    whereClauses.push(`c.email IS NOT NULL AND c.email != ''`);
  } else if (hasEmail === "false") {
    whereClauses.push(`(c.email IS NULL OR c.email = '')`);
  }

  if (sourceTypeFilter.length > 0) {
    whereClauses.push(`c.source_type IN (${sourceTypeFilter.map(() => "?").join(",")})`);
    whereParams.push(...sourceTypeFilter);
  }
  if (segmentFilter.length > 0) {
    whereClauses.push(`COALESCE(s.name, c.segment) IN (${segmentFilter.map(() => "?").join(",")})`);
    whereParams.push(...segmentFilter);
  }
  if (sourceQueryFilter.length > 0) {
    whereClauses.push(`c.source_query IN (${sourceQueryFilter.map(() => "?").join(",")})`);
    whereParams.push(...sourceQueryFilter);
  }
  if (tagAndFilter.length > 0) {
    // Every requested tag must be present.
    for (const t of tagAndFilter) {
      whereClauses.push(`c.tags LIKE ?`);
      whereParams.push(`%${t}%`);
    }
  }
  if (tagNotFilter.length > 0) {
    // None of these tags may be present.
    for (const t of tagNotFilter) {
      whereClauses.push(`(c.tags IS NULL OR c.tags NOT LIKE ?)`);
      whereParams.push(`%${t}%`);
    }
  }
  if (hasPhone === "true") {
    whereClauses.push(`c.phone IS NOT NULL AND c.phone != ''`);
  } else if (hasPhone === "false") {
    whereClauses.push(`(c.phone IS NULL OR c.phone = '')`);
  }

  const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
  const fromSQL = `FROM companies c LEFT JOIN segments s ON s.id = c.segment_id`;

  // Validate sort column
  const sortColumns: Record<string, string> = {
    name: "c.name",
    state: "c.state",
    city: "c.city",
    icp_score: "c.icp_score",
    status: "c.status",
    created_at: "c.created_at",
  };
  const sortCol = sortColumns[sort] || "c.name";

  // ids_only short-circuit — single-column SELECT, no joins, no
  // pagination, no JSON parsing. Caps at 50k to protect Node memory
  // from a runaway "select all of 130k companies" request.
  if (idsOnly) {
    const idRows = sqlite.prepare(
      `SELECT c.id ${fromSQL} ${whereSQL} LIMIT 50000`,
    ).all(...whereParams) as Array<{ id: string }>;
    return NextResponse.json({
      ids: idRows.map((r) => r.id),
      total: idRows.length,
      capped: idRows.length === 50000,
    });
  }

  // Count query
  const countResult = sqlite.prepare(`SELECT count(*) as total ${fromSQL} ${whereSQL}`).get(...whereParams) as { total: number };

  // Data query
  const rows = sqlite.prepare(`
    SELECT c.id, c.name, c.city, c.state, c.type, c.source, c.phone, c.email,
           c.icp_score, c.status, c.tags, c.website, c.domain, c.enrichment_status, COALESCE(s.name, c.segment) as segment, c.category,
           c.industry, c.source_type, c.source_id, c.source_query
    ${fromSQL}
    ${whereSQL}
    ORDER BY ${sortCol} ${order} NULLS LAST
    LIMIT ? OFFSET ?
  `).all(...whereParams, limit, offset) as Record<string, unknown>[];

  return NextResponse.json({
    data: rows.map(r => ({
      ...r,
      tags: parseTagsLenient(r.tags as string | null),
    })),
    total: countResult.total,
    page,
    limit,
    totalPages: Math.ceil(countResult.total / limit),
  });
}

/**
 * The companies.tags column carries a mix of formats from historical
 * imports + backfills:
 *
 *   - clean JSON array:        `["a","b","c"]`
 *   - plain comma-separated:   `a,b,c`
 *   - hybrid (broken JSON):    `["a","b"],c`  ← created by the
 *     brand-carrier backfill which appended ",brand_carrier" to
 *     existing JSON arrays. JSON.parse throws on these.
 *
 * This parser tolerates all three. Returns [] for null/empty input.
 * The downstream UI just needs an array of strings.
 */
function parseTagsLenient(raw: string | null): string[] {
  if (!raw) return [];
  const s = raw.trim();
  if (!s) return [];
  // Pure JSON array — the happy path.
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // Hybrid form: `["a","b"],c,d`. Find the matching `]` and
      // split the remainder by commas.
      const closeIdx = s.lastIndexOf("]");
      if (closeIdx > 0) {
        try {
          const head = JSON.parse(s.slice(0, closeIdx + 1));
          if (Array.isArray(head)) {
            const tail = s.slice(closeIdx + 1).split(",").map((t) => t.trim()).filter(Boolean);
            return [...head.map(String), ...tail];
          }
        } catch { /* fall through */ }
      }
    }
  }
  // Plain comma-separated string.
  return s.split(",").map((t) => t.trim()).filter(Boolean);
}
