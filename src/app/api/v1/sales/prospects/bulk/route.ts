import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { action, ids, params } = body as {
    action: string;
    ids: string[];
    params?: Record<string, unknown>;
  };

  if (!action || !ids || !Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "action and ids required" }, { status: 400 });
  }

  const now = new Date().toISOString();
  let affected = 0;

  const runBulk = sqlite.transaction(() => {
    const placeholders = ids.map(() => "?").join(",");

    switch (action) {
      case "approve": {
        const stmt = sqlite.prepare(`UPDATE companies SET status = 'qualified', updated_at = ? WHERE id IN (${placeholders})`);
        const result = stmt.run(now, ...ids);
        affected = result.changes;
        break;
      }
      case "reject": {
        const stmt = sqlite.prepare(`UPDATE companies SET status = 'rejected', updated_at = ? WHERE id IN (${placeholders})`);
        const result = stmt.run(now, ...ids);
        affected = result.changes;
        break;
      }
      case "tag": {
        const tag = params?.tag as string;
        if (!tag) throw new Error("tag param required");
        // Add tag to existing tags JSON array
        for (const id of ids) {
          const row = sqlite.prepare(`SELECT tags FROM companies WHERE id = ?`).get(id) as { tags: string | null } | undefined;
          const existing: string[] = row?.tags ? JSON.parse(row.tags) : [];
          if (!existing.includes(tag)) {
            existing.push(tag);
            sqlite.prepare(`UPDATE companies SET tags = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(existing), now, id);
          }
        }
        affected = ids.length;
        break;
      }
      case "assign": {
        const ownerId = params?.owner_id as string;
        if (!ownerId) throw new Error("owner_id param required");
        const stmt = sqlite.prepare(`UPDATE companies SET owner_id = ?, updated_at = ? WHERE id IN (${placeholders})`);
        const result = stmt.run(ownerId, now, ...ids);
        affected = result.changes;
        break;
      }
      default:
        throw new Error(`Unknown action: ${action}`);
    }

    // Log to change_logs
    sqlite.prepare(`
      INSERT INTO change_logs (id, entity_type, entity_id, field, old_value, new_value, source, request_id)
      VALUES (?, 'company', 'bulk', 'bulk_action', NULL, ?, 'api', ?)
    `).run(crypto.randomUUID(), JSON.stringify({ action, count: ids.length, params }), crypto.randomUUID());
  });

  try {
    runBulk();
    return NextResponse.json({ success: true, affected });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
