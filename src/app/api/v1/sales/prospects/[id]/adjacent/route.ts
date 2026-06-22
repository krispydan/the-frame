export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sp = request.nextUrl.searchParams;

  // Pipeline-walk mode: when arriving from the kanban with
  // `?pipeline=<stage>`, scope the prev/next list to companies whose
  // matching deal sits in that stage, ordered by deal last activity
  // (matches the kanban's "Sorted by: Last Activity" default).
  const pipelineStage = sp.get("pipeline")?.trim();

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
    whereClauses.push(`COALESCE(s.name, c.segment) IN (${segmentFilter.map(() => "?").join(",")})`);
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
  if (hasEmail === "true")
    whereClauses.push(
      `EXISTS (SELECT 1 FROM contacts ct WHERE ct.company_id = c.id AND TRIM(COALESCE(ct.email, '')) <> '')`,
    );
  else if (hasEmail === "false")
    whereClauses.push(
      `NOT EXISTS (SELECT 1 FROM contacts ct WHERE ct.company_id = c.id AND TRIM(COALESCE(ct.email, '')) <> '')`,
    );
  if (hasPhone === "true")
    whereClauses.push(
      `EXISTS (SELECT 1 FROM company_phones cp WHERE cp.company_id = c.id)`,
    );
  else if (hasPhone === "false")
    whereClauses.push(
      `NOT EXISTS (SELECT 1 FROM company_phones cp WHERE cp.company_id = c.id)`,
    );

  // Pipeline walk overrides the normal filter set — only the stage
  // filter applies, joining through the deals table.
  if (pipelineStage) {
    whereClauses.length = 0;
    whereParams.length = 0;
    whereClauses.push("d.stage = ?");
    whereParams.push(pipelineStage);
    whereClauses.push("(d.snooze_until IS NULL OR d.snooze_until <= datetime('now'))");
  }

  const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
  const fromSQL = pipelineStage
    ? `FROM deals d JOIN companies c ON c.id = d.company_id`
    : `FROM companies c LEFT JOIN segments s ON s.id = c.segment_id`;

  const sortColumns: Record<string, string> = {
    name: "c.name", state: "c.state", city: "c.city",
    icp_score: "c.icp_score", status: "c.status", created_at: "c.created_at",
  };
  const sortCol = pipelineStage
    ? "COALESCE(d.last_activity_at, d.updated_at, d.created_at)"
    : (sortColumns[sort] || "c.name");
  const sortOrder = pipelineStage ? "DESC" : `${order} NULLS LAST`;

  // Get ordered list of IDs
  const rows = sqlite.prepare(`
    SELECT c.id ${fromSQL} ${whereSQL} ORDER BY ${sortCol} ${sortOrder}
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
