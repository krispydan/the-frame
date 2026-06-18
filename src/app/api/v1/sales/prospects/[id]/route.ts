export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const company = sqlite.prepare(`
    SELECT c.*, COALESCE(s.name, c.segment) as segment, COALESCE(c.owner_name, u.name) as owner_name, u.name as assigned_owner_name
    FROM companies c
    LEFT JOIN segments s ON s.id = c.segment_id
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
    owner_id: "owner_id", notes: "notes",
    icp_score: "icp_score", icp_tier: "icp_tier", icp_reasoning: "icp_reasoning",
    tags: "tags",
    disqualify_reason: "disqualify_reason",
    segment: "segment",
    category: "category",
    lead_source_detail: "lead_source_detail",
    // NOTE: `status` is intentionally NOT in allowedFields here. Status
    // changes route through progressCompanyStatus (see below) so they
    // get forward-progression enforcement AND fan-out to Instantly +
    // PhoneBurner.
  };

  // ── status: special path through progressCompanyStatus ──
  let statusProgressionResult:
    | { updated: boolean; from: string | null; to: string }
    | null = null;
  if (typeof body.status === "string" && body.status.trim()) {
    const target = body.status.trim();
    // Log to change_logs the same way other fields do — preserves the
    // existing audit pattern.
    const oldStatus = (sqlite
      .prepare("SELECT status FROM companies WHERE id = ?")
      .get(id) as { status: string | null } | undefined)?.status ?? "";
    sqlite
      .prepare(
        `INSERT INTO change_logs (id, entity_type, entity_id, field, old_value, new_value, source)
         VALUES (?, 'company', ?, 'status', ?, ?, 'ui')`,
      )
      .run(crypto.randomUUID(), id, oldStatus, target);

    const { progressCompanyStatus } = await import(
      "@/modules/sales/lib/status-progression"
    );
    statusProgressionResult = progressCompanyStatus(
      id,
      target as Parameters<typeof progressCompanyStatus>[1],
      { source: "ui" },
    );
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  let pendingSegmentName: string | null | undefined;

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
    if (key === "segment") {
      pendingSegmentName = typeof val === "string" ? val.trim() : val == null ? null : String(val).trim();
    }
  }

  // A status-only PATCH is valid — it goes through the special
  // progressCompanyStatus path above. Only return 400 when neither
  // status nor any other field was supplied.
  if (sets.length === 0 && !statusProgressionResult) {
    return NextResponse.json({ error: "No valid fields" }, { status: 400 });
  }
  // Status-only patch — short-circuit before the UPDATE/segment block.
  if (sets.length === 0) {
    sqlite
      .prepare(
        `INSERT INTO activity_feed (id, event_type, module, entity_type, entity_id, data)
         VALUES (?, 'company_updated', 'sales', 'company', ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        id,
        JSON.stringify({ fields: ["status"], status: statusProgressionResult }),
      );
    return NextResponse.json({ success: true, status: statusProgressionResult });
  }

  if (pendingSegmentName !== undefined) {
    let segmentId: string | null = null;
    if (pendingSegmentName) {
      sqlite.prepare(`
        INSERT OR IGNORE INTO segments (id, name, slug, status, created_at, updated_at)
        VALUES (lower(hex(randomblob(16))), ?, lower(replace(trim(?), ' ', '-')), 'active', datetime('now'), datetime('now'))
      `).run(pendingSegmentName, pendingSegmentName);
      segmentId = (sqlite.prepare(
        `SELECT id FROM segments WHERE lower(trim(name)) = lower(trim(?)) LIMIT 1`
      ).get(pendingSegmentName) as { id: string } | undefined)?.id ?? null;
    }
    sets.push("segment_id = ?");
    values.push(segmentId);
  }

  // If the reviewer touched icp_score / icp_tier / icp_reasoning, treat the
  // edit as a manual override so the auto-classifier doesn't undo it.
  // Stamp icp_updated_by + icp_updated_at for audit + UI.
  const editedIcp = ["icp_score", "icp_tier", "icp_reasoning"].some((k) => k in body);
  if (editedIcp) {
    sets.push("icp_manual_override = 1");
    sets.push("icp_updated_at = datetime('now')");
    // best-effort attribution; skip if no session helper available here
    try {
      const { getSessionUser } = await import("@/lib/get-session");
      const user = await getSessionUser();
      if (user?.id) {
        sets.push("icp_updated_by = ?");
        values.push(user.id);
      }
    } catch { /* no session, leave NULL */ }
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
