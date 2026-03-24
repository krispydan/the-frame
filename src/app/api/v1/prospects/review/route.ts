export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const limit = Math.min(50, Math.max(1, parseInt(params.get("limit") || "20")));
  const offset = Math.max(0, parseInt(params.get("offset") || "0"));
  const sourceType = params.get("source_type");
  const state = params.getAll("state");
  const category = params.get("category");
  const status = params.get("status") || "new";
  const sort = params.get("sort") || "random";

  const whereClauses: string[] = [];
  const whereParams: unknown[] = [];

  if (status && status !== "all") {
    whereClauses.push("c.status = ?");
    whereParams.push(status);
  }
  if (sourceType && sourceType !== "all") {
    whereClauses.push("c.source_type = ?");
    whereParams.push(sourceType);
  }
  if (state.length > 0) {
    whereClauses.push(`c.state IN (${state.map(() => "?").join(",")})`);
    whereParams.push(...state);
  }
  if (category && category !== "all") {
    whereClauses.push("c.category LIKE ?");
    whereParams.push(`%${category}%`);
  }

  const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  let orderSQL = "ORDER BY RANDOM()";
  if (sort === "name") orderSQL = "ORDER BY c.name ASC";
  else if (sort === "rating") orderSQL = "ORDER BY c.google_rating DESC NULLS LAST";
  else if (sort === "reviews") orderSQL = "ORDER BY c.google_review_count DESC NULLS LAST";

  // Total count (for the specific filters)
  const countResult = sqlite.prepare(
    `SELECT count(*) as total FROM companies c ${whereSQL}`
  ).get(...whereParams) as { total: number };

  // Total reviewed (qualified + rejected) with same filters except status
  const reviewedWhere = whereClauses
    .filter(c => !c.startsWith("c.status"))
    .join(" AND ");
  const reviewedParams = whereParams.filter((_, i) => {
    // Remove the status param (always first if present)
    if (status && status !== "all" && i === 0) return false;
    return true;
  });
  const reviewedCountSQL = `SELECT count(*) as total FROM companies c WHERE c.status IN ('qualified', 'rejected')${reviewedWhere ? ` AND ${reviewedWhere}` : ""}`;
  const reviewedResult = sqlite.prepare(reviewedCountSQL).get(...reviewedParams) as { total: number };

  // Total across all statuses with same non-status filters
  const allCountSQL = `SELECT count(*) as total FROM companies c${reviewedWhere ? ` WHERE ${reviewedWhere}` : ""}`;
  const allResult = sqlite.prepare(allCountSQL).get(...reviewedParams) as { total: number };

  // Data query - lightweight fields only
  const rows = sqlite.prepare(`
    SELECT c.id, c.name, c.address, c.city, c.state, c.zip, c.phone, c.email,
           c.website, c.domain, c.google_rating, c.google_review_count,
           c.source_type, c.source_query, c.category, c.segment, c.status,
           c.source, c.tags
    FROM companies c
    ${whereSQL}
    ${orderSQL}
    LIMIT ? OFFSET ?
  `).all(...whereParams, limit, offset) as Record<string, unknown>[];

  return NextResponse.json({
    data: rows.map(r => ({
      ...r,
      tags: r.tags ? JSON.parse(r.tags as string) : [],
    })),
    total: countResult.total,
    reviewed: reviewedResult.total,
    allCount: allResult.total,
    limit,
    offset,
  });
}
