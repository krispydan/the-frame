import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { eventBus } from "@/modules/core/lib/event-bus";
import { logger } from "@/modules/core/lib/logger";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deal = sqlite.prepare(`
    SELECT d.*, c.name as company_name, c.city as company_city, c.state as company_state,
           c.email as company_email, c.phone as company_phone, c.website as company_website
    FROM deals d
    LEFT JOIN companies c ON c.id = d.company_id
    WHERE d.id = ?
  `).get(id);

  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const activities = sqlite.prepare(`
    SELECT * FROM deal_activities WHERE deal_id = ? ORDER BY created_at DESC
  `).all(id);

  const contacts = sqlite.prepare(`
    SELECT * FROM contacts WHERE company_id = (SELECT company_id FROM deals WHERE id = ?) ORDER BY is_primary DESC
  `).all(id);

  return NextResponse.json({ deal, activities, contacts });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  const deal = sqlite.prepare("SELECT * FROM deals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const allowedFields = ["title", "value", "stage", "channel", "owner_id", "store_id", "contact_id"];
  const sets: string[] = ["updated_at = ?"];
  const vals: unknown[] = [now];

  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      sets.push(`${field} = ?`);
      vals.push(body[field]);
    }
  }

  vals.push(id);
  sqlite.prepare(`UPDATE deals SET ${sets.join(", ")} WHERE id = ?`).run(...vals);

  // Handle stage change
  if (body.stage && body.stage !== deal.stage) {
    // Store previous stage
    sqlite.prepare("UPDATE deals SET previous_stage = ? WHERE id = ?").run(deal.stage, id);

    sqlite.prepare(`
      INSERT INTO deal_activities (id, deal_id, company_id, type, description, metadata, created_at)
      VALUES (?, ?, ?, 'stage_change', ?, ?, ?)
    `).run(crypto.randomUUID(), id, deal.company_id, `Stage: ${deal.stage} → ${body.stage}`, JSON.stringify({ from: deal.stage, to: body.stage }), now);

    eventBus.emit("deal.stage_changed", { dealId: id, fromStage: deal.stage as string, toStage: body.stage });

    // If moved to order_placed, set reorder_due_at
    if (body.stage === "order_placed") {
      const reorderDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
      sqlite.prepare("UPDATE deals SET closed_at = ?, reorder_due_at = ? WHERE id = ?").run(now, reorderDate, id);
      eventBus.emit("deal.won", { dealId: id, companyId: deal.company_id as string, value: (body.value ?? deal.value ?? 0) as number });
    }

    logger.logChange("deal", id, "stage", deal.stage as string, body.stage, null, "api");
  }

  // Handle owner change
  if (body.owner_id && body.owner_id !== deal.owner_id) {
    sqlite.prepare(`
      INSERT INTO deal_activities (id, deal_id, company_id, type, description, metadata, created_at)
      VALUES (?, ?, ?, 'owner_change', ?, ?, ?)
    `).run(crypto.randomUUID(), id, deal.company_id, `Owner changed`, JSON.stringify({ from: deal.owner_id, to: body.owner_id }), now);
    logger.logChange("deal", id, "owner_id", deal.owner_id as string || null, body.owner_id, null, "api");
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  sqlite.prepare("DELETE FROM deal_activities WHERE deal_id = ?").run(id);
  sqlite.prepare("DELETE FROM deals WHERE id = ?").run(id);
  return NextResponse.json({ success: true });
}
