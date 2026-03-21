export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { eventBus } from "@/modules/core/lib/event-bus";
import { logger } from "@/modules/core/lib/logger";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const stage = params.get("stage");
  const ownerId = params.get("owner_id");
  const companyId = params.get("company_id");
  const tab = params.get("tab") || "active"; // active | snoozed | reorder
  const page = Math.max(1, parseInt(params.get("page") || "1"));
  const limit = Math.min(100, parseInt(params.get("limit") || "100"));
  const offset = (page - 1) * limit;

  const clauses: string[] = [];
  const vals: unknown[] = [];

  if (tab === "snoozed") {
    clauses.push("d.snooze_until IS NOT NULL AND d.snooze_until > datetime('now')");
  } else if (tab === "reorder") {
    clauses.push("d.reorder_due_at IS NOT NULL AND d.reorder_due_at <= datetime('now', '+14 days')");
    clauses.push("d.stage = 'order_placed'");
  } else {
    // active: not snoozed
    clauses.push("(d.snooze_until IS NULL OR d.snooze_until <= datetime('now'))");
  }

  if (stage) {
    clauses.push("d.stage = ?");
    vals.push(stage);
  }
  if (ownerId) {
    clauses.push("d.owner_id = ?");
    vals.push(ownerId);
  }
  if (companyId) {
    clauses.push("d.company_id = ?");
    vals.push(companyId);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const total = (sqlite.prepare(`SELECT count(*) as c FROM deals d ${where}`).get(...vals) as { c: number }).c;

  const rows = sqlite.prepare(`
    SELECT d.*, c.name as company_name, c.city as company_city, c.state as company_state
    FROM deals d
    LEFT JOIN companies c ON c.id = d.company_id
    ${where}
    ORDER BY d.last_activity_at DESC
    LIMIT ? OFFSET ?
  `).all(...vals, limit, offset);

  return NextResponse.json({ data: rows, total, page, limit });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { company_id, store_id, contact_id, title, value, stage, channel, owner_id, notes } = body;

  if (!company_id || !title) {
    return NextResponse.json({ error: "company_id and title required" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  sqlite.prepare(`
    INSERT INTO deals (id, company_id, store_id, contact_id, title, value, stage, channel, owner_id, last_activity_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, company_id, store_id || null, contact_id || null, title, value || null, stage || "outreach", channel || null, owner_id || null, now, now, now);

  // Log initial activity
  if (notes) {
    sqlite.prepare(`
      INSERT INTO deal_activities (id, deal_id, company_id, type, description, created_at)
      VALUES (?, ?, ?, 'note', ?, ?)
    `).run(crypto.randomUUID(), id, company_id, notes, now);
  }

  // Stage change activity
  sqlite.prepare(`
    INSERT INTO deal_activities (id, deal_id, company_id, type, description, metadata, created_at)
    VALUES (?, ?, ?, 'stage_change', ?, ?, ?)
  `).run(crypto.randomUUID(), id, company_id, `Deal created in ${stage || "outreach"}`, JSON.stringify({ from: null, to: stage || "outreach" }), now);

  logger.logChange("deal", id, "created", null, stage || "outreach", null, "api");

  return NextResponse.json({ id, success: true }, { status: 201 });
}
