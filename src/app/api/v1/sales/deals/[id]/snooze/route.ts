import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { logger } from "@/modules/core/lib/logger";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const { until, reason } = body;

  if (!until) return NextResponse.json({ error: "until date required" }, { status: 400 });

  const deal = sqlite.prepare("SELECT * FROM deals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 });

  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  sqlite.prepare(`
    UPDATE deals SET snooze_until = ?, snooze_reason = ?, previous_stage = stage, updated_at = ? WHERE id = ?
  `).run(until, reason || null, now, id);

  sqlite.prepare(`
    INSERT INTO deal_activities (id, deal_id, company_id, type, description, metadata, created_at)
    VALUES (?, ?, ?, 'snooze', ?, ?, ?)
  `).run(crypto.randomUUID(), id, deal.company_id, `Snoozed until ${until}${reason ? `: ${reason}` : ""}`, JSON.stringify({ until, reason }), now);

  logger.logChange("deal", id, "snooze_until", null, until, null, "api");

  return NextResponse.json({ success: true });
}

// Unsnooze
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  sqlite.prepare("UPDATE deals SET snooze_until = NULL, snooze_reason = NULL, updated_at = ? WHERE id = ?").run(now, id);
  return NextResponse.json({ success: true });
}
