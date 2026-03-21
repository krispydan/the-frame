/**
 * F3-003: Campaign CRUD API
 * GET /api/v1/sales/campaigns — list with filters
 * POST /api/v1/sales/campaigns — create campaign
 */
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { logger } from "@/modules/core/lib/logger";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const type = params.get("type");
  const status = params.get("status");
  const page = Math.max(1, parseInt(params.get("page") || "1"));
  const limit = Math.min(100, parseInt(params.get("limit") || "50"));
  const offset = (page - 1) * limit;

  const clauses: string[] = [];
  const vals: unknown[] = [];

  if (type) { clauses.push("c.type = ?"); vals.push(type); }
  if (status) { clauses.push("c.status = ?"); vals.push(status); }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const total = (sqlite.prepare(`SELECT count(*) as c FROM campaigns c ${where}`).get(...vals) as { c: number }).c;

  const rows = sqlite.prepare(`
    SELECT c.*,
      (SELECT count(*) FROM campaign_leads cl WHERE cl.campaign_id = c.id) as lead_count
    FROM campaigns c
    ${where}
    ORDER BY c.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...vals, limit, offset);

  // Summary stats
  const summary = sqlite.prepare(`
    SELECT
      count(CASE WHEN status = 'active' THEN 1 END) as active_campaigns,
      coalesce(sum(sent), 0) as total_sent,
      CASE WHEN sum(sent) > 0 THEN round(cast(sum(opened) as real) / sum(sent) * 100, 1) ELSE 0 END as avg_open_rate,
      CASE WHEN sum(sent) > 0 THEN round(cast(sum(replied) as real) / sum(sent) * 100, 1) ELSE 0 END as avg_reply_rate
    FROM campaigns
  `).get() as Record<string, number>;

  return NextResponse.json({ data: rows, total, page, limit, summary });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, type, description, target_segment, target_smart_list_id, variant_a_subject, variant_b_subject } = body;

  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const id = crypto.randomUUID();
  sqlite.prepare(`
    INSERT INTO campaigns (id, name, type, description, target_segment, target_smart_list_id, variant_a_subject, variant_b_subject)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, type || "email_sequence", description, target_segment, target_smart_list_id, variant_a_subject, variant_b_subject);

  const campaign = sqlite.prepare("SELECT * FROM campaigns WHERE id = ?").get(id);
  logger.logEvent("campaign_created", "sales", { id, name });

  return NextResponse.json({ data: campaign }, { status: 201 });
}
