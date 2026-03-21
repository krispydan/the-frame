export const dynamic = "force-dynamic";
/**
 * Campaign detail + update + delete
 */
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { logger } from "@/modules/core/lib/logger";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const campaign = sqlite.prepare(`
    SELECT c.*,
      (SELECT count(*) FROM campaign_leads cl WHERE cl.campaign_id = c.id) as lead_count,
      (SELECT count(*) FROM campaign_leads cl WHERE cl.campaign_id = c.id AND cl.status = 'replied') as reply_count
    FROM campaigns c WHERE c.id = ?
  `).get(id);

  if (!campaign) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const leads = sqlite.prepare(`
    SELECT cl.*, co.name as company_name, ct.first_name, ct.last_name, ct.email as contact_email
    FROM campaign_leads cl
    LEFT JOIN companies co ON co.id = cl.company_id
    LEFT JOIN contacts ct ON ct.id = cl.contact_id
    WHERE cl.campaign_id = ?
    ORDER BY cl.created_at DESC
    LIMIT 100
  `).all(id);

  return NextResponse.json({ data: { ...campaign as Record<string, unknown>, leads } });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const allowed = ["name", "type", "status", "description", "target_segment", "target_smart_list_id", "variant_a_subject", "variant_b_subject", "meetings_booked", "orders_placed", "instantly_campaign_id"];
  const sets: string[] = [];
  const vals: unknown[] = [];

  for (const key of allowed) {
    if (key in body) {
      sets.push(`${key} = ?`);
      vals.push(body[key]);
    }
  }

  if (sets.length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  sets.push("updated_at = datetime('now')");
  vals.push(id);

  sqlite.prepare(`UPDATE campaigns SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  const campaign = sqlite.prepare("SELECT * FROM campaigns WHERE id = ?").get(id);
  logger.logEvent("campaign_updated", "sales", { id });

  return NextResponse.json({ data: campaign });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  sqlite.prepare("DELETE FROM campaign_leads WHERE campaign_id = ?").run(id);
  sqlite.prepare("DELETE FROM campaigns WHERE id = ?").run(id);
  logger.logEvent("campaign_deleted", "sales", { id });
  return NextResponse.json({ success: true });
}
