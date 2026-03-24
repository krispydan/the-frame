export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sp = request.nextUrl.searchParams;

  const search = sp.get("search")?.trim();
  const sort = sp.get("sort") || "name";
  const order = sp.get("order") === "desc" ? "DESC" : "ASC";
  const stateFilter = sp.getAll("state");
  const categoryFilter = sp.getAll("category");
  const sourceFilter = sp.getAll("source");
  const statusFilter = sp.getAll("status");
  const segmentFilter = sp.getAll("segment");
  const icpMin = sp.get("icp_min");
  const icpMax = sp.get("icp_max");
  const hasEmail = sp.get("has_email");
  const hasPhone = sp.get("has_phone");

  const whereClauses: string[] = [];
  const whereParams: unknown[] = [];

  if (search) {
    try {
      const ftsResults = sqlite.prepare(
        `SELECT rowid FROM companies_fts WHERE companies_fts MATCH ? LIMIT 10000`
      ).all(search + "*") as { rowid: number }[];
      if (ftsResults.length === 0) {
        return NextResponse.json({ prev: null, next: null });
      }
      whereClauses.push(`c.rowid IN (${ftsResults.map(r => r.rowid).join(",")})`);
    } catch {
      whereClauses.push(`c.name LIKE ?`);
      whereParams.push(`%${search}%`);
    }
  }

  if (stateFilter.length > 0) {
    whereClauses.push(`c.state IN (${stateFilter.map(() => "?").join(",")})`);
    whereParams.push(...stateFilter);
  }
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
  if (segmentFilter.length > 0) {
    whereClauses.push(`c.segment IN (${segmentFilter.map(() => "?").join(",")})`);
    whereParams.push(...segmentFilter);
  }
  if (statusFilter.length > 0) {
    whereClauses.push(`c.status IN (${statusFilter.map(() => "?").join(",")})`);
    whereParams.push(...statusFilter);
  } else {
    whereClauses.push(`c.status != 'rejected'`);
  }
  if (icpMin) { whereClauses.push(`c.icp_score >= ?`); whereParams.push(parseInt(icpMin)); }
  if (icpMax) { whereClauses.push(`c.icp_score <= ?`); whereParams.push(parseInt(icpMax)); }
  if (hasEmail === "true") whereClauses.push(`c.email IS NOT NULL AND c.email != ''`);
  else if (hasEmail === "false") whereClauses.push(`(c.email IS NULL OR c.email = '')`);
  if (hasPhone === "true") whereClauses.push(`c.phone IS NOT NULL AND c.phone != ''`);
  else if (hasPhone === "false") whereClauses.push(`(c.phone IS NULL OR c.phone = '')`);

  const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const sortColumns: Record<string, string> = {
    name: "c.name", state: "c.state", city: "c.city",
    icp_score: "c.icp_score", status: "c.status", created_at: "c.created_at",
  };
  const sortCol = sortColumns[sort] || "c.name";

  // Get ordered list of IDs
  const rows = sqlite.prepare(`
    SELECT c.id FROM companies c ${whereSQL} ORDER BY ${sortCol} ${order} NULLS LAST
  `).all(...whereParams) as { id: string }[];

  const total = rows.length;
  const idx = rows.findIndex(r => r.id === id);
  if (idx === -1) {
    return NextResponse.json({ prev: null, next: null, position: null, total });
  }

  return NextResponse.json({
    prev: idx > 0 ? rows[idx - 1].id : null,
    next: idx < rows.length - 1 ? rows[idx + 1].id : null,
    position: idx + 1,
    total,
  });
}
