export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { store_id, company_id, first_name, last_name, title, email, phone, is_primary } = body;

  if (!company_id) return NextResponse.json({ error: "company_id required" }, { status: 400 });

  const id = crypto.randomUUID();
  sqlite.prepare(`
    INSERT INTO contacts (id, store_id, company_id, first_name, last_name, title, email, phone, is_primary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, store_id || null, company_id, first_name || null, last_name || null, title || null, email || null, phone || null, is_primary ? 1 : 0);

  sqlite.prepare(`
    INSERT INTO activity_feed (id, event_type, module, entity_type, entity_id, data)
    VALUES (?, 'contact_created', 'sales', 'contact', ?, ?)
  `).run(crypto.randomUUID(), id, JSON.stringify({ company_id, name: `${first_name || ""} ${last_name || ""}`.trim() }));

  return NextResponse.json({ data: { id, ...body } }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { id, ...fields } = body;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const allowed = ["first_name", "last_name", "title", "email", "phone", "is_primary", "notes"];
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const [key, val] of Object.entries(fields)) {
    if (!allowed.includes(key)) continue;
    sets.push(`${key} = ?`);
    values.push(key === "is_primary" ? (val ? 1 : 0) : val);
  }

  if (sets.length === 0) return NextResponse.json({ error: "No valid fields" }, { status: 400 });

  sets.push("updated_at = datetime('now')");
  values.push(id);
  sqlite.prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ?`).run(...values);

  return NextResponse.json({ success: true });
}
