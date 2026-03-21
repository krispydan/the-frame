export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const activities = sqlite.prepare(`
    SELECT * FROM deal_activities WHERE deal_id = ? ORDER BY created_at DESC
  `).all(id);
  return NextResponse.json({ data: activities });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const { type, description, metadata } = body;

  if (!type) return NextResponse.json({ error: "type required" }, { status: 400 });

  const deal = sqlite.prepare("SELECT company_id FROM deals WHERE id = ?").get(id) as { company_id: string } | undefined;
  if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 });

  const actId = crypto.randomUUID();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  sqlite.prepare(`
    INSERT INTO deal_activities (id, deal_id, company_id, type, description, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(actId, id, deal.company_id, type, description || null, metadata ? JSON.stringify(metadata) : null, now);

  // Update last_activity_at
  sqlite.prepare("UPDATE deals SET last_activity_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);

  return NextResponse.json({ id: actId, success: true }, { status: 201 });
}
