export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const page = Math.max(1, parseInt(params.get("page") || "1"));
  const limit = Math.min(100, Math.max(1, parseInt(params.get("limit") || "25")));
  const search = params.get("search")?.trim();
  const sort = params.get("sort") || "match_count";
  const order = params.get("order") === "asc" ? "ASC" : "DESC";
  const sectorFilter = params.getAll("sector");
  const relevanceFilter = params.getAll("relevance");
  const brandTypeFilter = params.getAll("brand_type");
  const minMatches = params.get("min_matches");
  const maxMatches = params.get("max_matches");

  const offset = (page - 1) * limit;

  const whereClauses: string[] = [];
  const whereParams: unknown[] = [];

  if (search) {
    whereClauses.push("b.name LIKE ?");
    whereParams.push(`%${search}%`);
  }

  if (sectorFilter.length > 0) {
    whereClauses.push(`b.sector IN (${sectorFilter.map(() => "?").join(",")})`);
    whereParams.push(...sectorFilter);
  }

  if (relevanceFilter.length > 0) {
    whereClauses.push(`b.relevance IN (${relevanceFilter.map(() => "?").join(",")})`);
    whereParams.push(...relevanceFilter);
  }

  if (brandTypeFilter.length > 0) {
    whereClauses.push(`b.brand_type IN (${brandTypeFilter.map(() => "?").join(",")})`);
    whereParams.push(...brandTypeFilter);
  }

  const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  // Having clauses for match count filtering
  const havingClauses: string[] = [];
  const havingParams: unknown[] = [];

  if (minMatches) {
    havingClauses.push("match_count >= ?");
    havingParams.push(parseInt(minMatches));
  }
  if (maxMatches) {
    havingClauses.push("match_count <= ?");
    havingParams.push(parseInt(maxMatches));
  }

  const havingSQL = havingClauses.length > 0 ? `HAVING ${havingClauses.join(" AND ")}` : "";

  const sortColumns: Record<string, string> = {
    name: "b.name",
    sector: "b.sector",
    relevance: "b.relevance",
    brand_type: "b.brand_type",
    match_count: "match_count",
    us_locations: "b.us_locations",
    total_locations: "b.total_locations",
  };
  const sortCol = sortColumns[sort] || "match_count";

  // Count query (with having filters applied)
  const countResult = sqlite.prepare(`
    SELECT count(*) as total FROM (
      SELECT b.id, count(cbl.id) as match_count
      FROM brand_accounts b
      LEFT JOIN company_brand_links cbl ON cbl.brand_account_id = b.id
      ${whereSQL}
      GROUP BY b.id
      ${havingSQL}
    )
  `).get(...whereParams, ...havingParams) as { total: number };

  // Data query
  const rows = sqlite.prepare(`
    SELECT b.id, b.external_id, b.name, b.website, b.sector, b.relevance, b.brand_type,
           b.us_locations, b.total_locations, b.top_country,
           count(cbl.id) as match_count
    FROM brand_accounts b
    LEFT JOIN company_brand_links cbl ON cbl.brand_account_id = b.id
    ${whereSQL}
    GROUP BY b.id
    ${havingSQL}
    ORDER BY ${sortCol} ${order} NULLS LAST
    LIMIT ? OFFSET ?
  `).all(...whereParams, ...havingParams, limit, offset) as Record<string, unknown>[];

  return NextResponse.json({
    data: rows,
    total: countResult.total,
    page,
    limit,
    totalPages: Math.ceil(countResult.total / limit),
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { action, ids, params: actionParams } = body as {
    action: string;
    ids: string[];
    params?: Record<string, unknown>;
  };

  if (!action || !ids || !Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "action and ids required" }, { status: 400 });
  }

  const now = new Date().toISOString();
  let affected = 0;

  const runBulk = sqlite.transaction(() => {
    const placeholders = ids.map(() => "?").join(",");

    switch (action) {
      case "mark_relevant": {
        const stmt = sqlite.prepare(`UPDATE brand_accounts SET relevance = 'relevant', updated_at = ? WHERE id IN (${placeholders})`);
        affected = stmt.run(now, ...ids).changes;
        break;
      }
      case "mark_irrelevant": {
        const stmt = sqlite.prepare(`UPDATE brand_accounts SET relevance = 'irrelevant', updated_at = ? WHERE id IN (${placeholders})`);
        affected = stmt.run(now, ...ids).changes;
        break;
      }
      case "mark_needs_review": {
        const stmt = sqlite.prepare(`UPDATE brand_accounts SET relevance = 'needs_review', updated_at = ? WHERE id IN (${placeholders})`);
        affected = stmt.run(now, ...ids).changes;
        break;
      }
      case "dq_stores": {
        // DQ all companies linked to these brands
        for (const brandId of ids) {
          const brand = sqlite.prepare("SELECT name FROM brand_accounts WHERE id = ?").get(brandId) as { name: string } | undefined;
          const brandName = brand?.name || "Unknown";
          const result = sqlite.prepare(`
            UPDATE companies SET status = 'rejected', disqualify_reason = ?, updated_at = ?
            WHERE id IN (SELECT company_id FROM company_brand_links WHERE brand_account_id = ?)
            AND status != 'rejected'
          `).run(`Brand DQ: ${brandName}`, now, brandId);
          affected += result.changes;
        }
        break;
      }
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  });

  try {
    runBulk();
    return NextResponse.json({ success: true, affected });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
