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
  const categoryFilter = params.getAll("category");
  const sourceFilter = params.getAll("source");
  const statusFilter = params.getAll("status");
  const icpMin = params.get("icp_min");
  const icpMax = params.get("icp_max");
  const segmentFilter = params.getAll("segment");
  const hasEmail = params.get("has_email");
  const hasPhone = params.get("has_phone");

  const offset = (page - 1) * limit;

  // Build WHERE clauses
  const whereClauses: string[] = [];
  const whereParams: unknown[] = [];

  // FTS search - get matching rowids first
  let ftsRowIds: number[] | null = null;
  if (search) {
    try {
      const ftsResults = sqlite.prepare(`
        SELECT rowid FROM companies_fts WHERE companies_fts MATCH ? LIMIT 10000
      `).all(search + "*") as { rowid: number }[];
      ftsRowIds = ftsResults.map(r => r.rowid);
      if (ftsRowIds.length === 0) {
        return NextResponse.json({ data: [], total: 0, page, limit, totalPages: 0 });
      }
      whereClauses.push(`c.rowid IN (${ftsRowIds.join(",")})`);
    } catch {
      // Fallback to LIKE search if FTS query is invalid
      whereClauses.push(`c.name LIKE ?`);
      whereParams.push(`%${search}%`);
    }
  }

  if (stateFilter.length > 0) {
    whereClauses.push(`c.state IN (${stateFilter.map(() => "?").join(",")})`);
    whereParams.push(...stateFilter);
  }

  if (categoryFilter.length > 0) {
    // Category is in tags JSON array
    const catConditions = categoryFilter.map(() => `c.tags LIKE ?`);
    whereClauses.push(`(${catConditions.join(" OR ")})`);
    whereParams.push(...categoryFilter.map(c => `%${c}%`));
  }

  if (sourceFilter.length > 0) {
    const srcConditions = sourceFilter.map(() => `c.source LIKE ?`);
    whereClauses.push(`(${srcConditions.join(" OR ")})`);
    whereParams.push(...sourceFilter.map(s => `%${s}%`));
  }

  if (segmentFilter.length > 0) {
    whereClauses.push(`c.segment IN (${segmentFilter.map(() => "?").join(",")})`);
    whereParams.push(...segmentFilter);
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

  if (hasPhone === "true") {
    whereClauses.push(`c.phone IS NOT NULL AND c.phone != ''`);
  } else if (hasPhone === "false") {
    whereClauses.push(`(c.phone IS NULL OR c.phone = '')`);
  }

  const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

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

  // Count query
  const countResult = sqlite.prepare(`SELECT count(*) as total FROM companies c ${whereSQL}`).get(...whereParams) as { total: number };

  // Data query
  const rows = sqlite.prepare(`
    SELECT c.id, c.name, c.city, c.state, c.type, c.source, c.phone, c.email, 
           c.icp_score, c.status, c.tags, c.website, c.domain, c.enrichment_status
    FROM companies c
    ${whereSQL}
    ORDER BY ${sortCol} ${order} NULLS LAST
    LIMIT ? OFFSET ?
  `).all(...whereParams, limit, offset) as Record<string, unknown>[];

  return NextResponse.json({
    data: rows.map(r => ({
      ...r,
      tags: r.tags ? JSON.parse(r.tags as string) : [],
    })),
    total: countResult.total,
    page,
    limit,
    totalPages: Math.ceil(countResult.total / limit),
  });
}
