export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const updates: { id: string; status: string; disqualify_reason?: string; segment?: string }[] = body.updates;

  if (!Array.isArray(updates) || updates.length === 0) {
    return NextResponse.json({ error: "updates array required" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const statusStmt = sqlite.prepare(
    `UPDATE companies SET status = ?, disqualify_reason = ?, updated_at = ? WHERE id = ?`
  );
  const ensureSegmentStmt = sqlite.prepare(`
    INSERT OR IGNORE INTO segments (id, name, slug, status, created_at, updated_at)
    VALUES (lower(hex(randomblob(16))), ?, lower(replace(trim(?), ' ', '-')), 'active', ?, ?)
  `);
  const findSegmentStmt = sqlite.prepare(
    `SELECT id FROM segments WHERE lower(trim(name)) = lower(trim(?)) LIMIT 1`
  );
  const segmentStmt = sqlite.prepare(
    `UPDATE companies SET segment = ?, segment_id = ?, updated_at = ? WHERE id = ?`
  );

  const transaction = sqlite.transaction(() => {
    for (const u of updates) {
      if (u.status) {
        statusStmt.run(u.status, u.disqualify_reason || null, now, u.id);
      }
      if (u.segment !== undefined) {
        const segmentName = u.segment?.trim() || null;
        let segmentId: string | null = null;
        if (segmentName) {
          ensureSegmentStmt.run(segmentName, segmentName, now, now);
          segmentId = (findSegmentStmt.get(segmentName) as { id: string } | undefined)?.id ?? null;
        }
        segmentStmt.run(segmentName, segmentId, now, u.id);
      }
    }
  });

  transaction();

  return NextResponse.json({ success: true, updated: updates.length });
}
