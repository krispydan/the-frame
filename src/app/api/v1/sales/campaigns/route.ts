export const dynamic = "force-dynamic";
/**
 * F3-003: Campaign CRUD API
 * GET /api/v1/sales/campaigns — list with filters
 * POST /api/v1/sales/campaigns — create campaign
 */
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { logger } from "@/modules/core/lib/logger";

function normalizeTargetSegment(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const match = sqlite.prepare(`
    SELECT name
    FROM segments
    WHERE lower(trim(name)) = lower(trim(?))
    LIMIT 1
  `).get(trimmed) as { name: string } | undefined;

  return match?.name ?? trimmed;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const type = params.get("type");
  const status = params.get("status");
  const segment = normalizeTargetSegment(params.get("segment"));
  const page = Math.max(1, parseInt(params.get("page") || "1"));
  const limit = Math.min(100, parseInt(params.get("limit") || "50"));
  const offset = (page - 1) * limit;

  const clauses: string[] = [];
  const vals: unknown[] = [];

  if (type) { clauses.push("c.type = ?"); vals.push(type); }
  if (status) { clauses.push("c.status = ?"); vals.push(status); }
  if (segment) { clauses.push("lower(trim(c.target_segment)) = lower(trim(?))"); vals.push(segment); }

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

  // channels[] is the multi-select delivery routing. Default to
  // ["instantly"] for back-compat; derive from legacy `type` if the
  // caller is on the old single-channel form.
  const VALID_CHANNELS = new Set(["instantly", "phoneburner", "direct_mail"]);
  let channels: string[] = Array.isArray(body.channels)
    ? body.channels.filter((c: unknown) => typeof c === "string" && VALID_CHANNELS.has(c))
    : [];
  if (channels.length === 0) {
    channels = type === "calling" ? ["phoneburner"] : ["instantly"];
  }

  const id = crypto.randomUUID();
  const normalizedTargetSegment = normalizeTargetSegment(target_segment);
  sqlite.prepare(`
    INSERT INTO campaigns (id, name, type, description, target_segment, target_smart_list_id, variant_a_subject, variant_b_subject, instantly_campaign_id, channels)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, name, type || "email_sequence", description, normalizedTargetSegment, target_smart_list_id,
    variant_a_subject, variant_b_subject, body.instantly_campaign_id || null,
    JSON.stringify(channels),
  );

  const campaign = sqlite.prepare("SELECT * FROM campaigns WHERE id = ?").get(id);
  logger.logEvent("campaign_created", "sales", { id, name, channels });

  return NextResponse.json({ data: campaign }, { status: 201 });
}
