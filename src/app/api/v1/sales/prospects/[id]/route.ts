export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const company = sqlite.prepare(`
    SELECT c.*, u.name as owner_name
    FROM companies c
    LEFT JOIN users u ON u.id = c.owner_id
    WHERE c.id = ?
  `).get(id) as Record<string, unknown> | undefined;

  if (!company) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Get stores
  const storeRows = sqlite.prepare(`
    SELECT * FROM stores WHERE company_id = ? ORDER BY is_primary DESC, name ASC
  `).all(id) as Record<string, unknown>[];

  // Get contacts grouped by store
  const contactRows = sqlite.prepare(`
    SELECT * FROM contacts WHERE company_id = ? ORDER BY is_primary DESC, first_name ASC
  `).all(id) as Record<string, unknown>[];

  // Get activity feed
  const activities = sqlite.prepare(`
    SELECT * FROM activity_feed
    WHERE entity_id = ? OR entity_id IN (SELECT id FROM stores WHERE company_id = ?)
    ORDER BY created_at DESC LIMIT 50
  `).all(id, id) as Record<string, unknown>[];

  // Get change logs for notes/status changes
  const changes = sqlite.prepare(`
    SELECT * FROM change_logs
    WHERE entity_id = ? AND entity_type = 'company'
    ORDER BY timestamp DESC LIMIT 50
  `).all(id) as Record<string, unknown>[];

  return NextResponse.json({
    company: {
      ...company,
      tags: company.tags ? JSON.parse(company.tags as string) : [],
    },
    stores: storeRows,
    contacts: contactRows.map(c => ({
      ...c,
      is_primary: Boolean(c.is_primary),
    })),
    activities: [...activities, ...changes.map(c => ({
      id: c.id,
      event_type: "change",
      module: "sales",
      entity_type: c.entity_type,
      entity_id: c.entity_id,
      data: JSON.stringify({ field: c.field, old: c.old_value, new: c.new_value, source: c.source }),
      user_id: c.user_id,
      created_at: c.timestamp,
    }))].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))).slice(0, 50),
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  const allowedFields: Record<string, string> = {
    name: "name", email: "email", phone: "phone", website: "website",
    address: "address", city: "city", state: "state", zip: "zip",
    status: "status", owner_id: "owner_id", notes: "notes",
    icp_score: "icp_score", icp_tier: "icp_tier", icp_reasoning: "icp_reasoning",
    tags: "tags",
  };

  const sets: string[] = [];
  const values: unknown[] = [];

  for (const [key, val] of Object.entries(body)) {
    const col = allowedFields[key];
    if (!col) continue;

    // Log change
    const old = sqlite.prepare(`SELECT ${col} FROM companies WHERE id = ?`).get(id) as Record<string, unknown>;
    const oldVal = old ? String(old[col] ?? "") : "";
    const newVal = key === "tags" ? JSON.stringify(val) : String(val ?? "");

    sqlite.prepare(`
      INSERT INTO change_logs (id, entity_type, entity_id, field, old_value, new_value, source)
      VALUES (?, 'company', ?, ?, ?, ?, 'ui')
    `).run(crypto.randomUUID(), id, col, oldVal, newVal);

    sets.push(`${col} = ?`);
    values.push(key === "tags" ? JSON.stringify(val) : val);
  }

  if (sets.length === 0) {
    return NextResponse.json({ error: "No valid fields" }, { status: 400 });
  }

  sets.push("updated_at = datetime('now')");
  values.push(id);

  sqlite.prepare(`UPDATE companies SET ${sets.join(", ")} WHERE id = ?`).run(...values);

  // Log activity
  sqlite.prepare(`
    INSERT INTO activity_feed (id, event_type, module, entity_type, entity_id, data)
    VALUES (?, 'company_updated', 'sales', 'company', ?, ?)
  `).run(crypto.randomUUID(), id, JSON.stringify({ fields: Object.keys(body) }));

  return NextResponse.json({ success: true });
}
