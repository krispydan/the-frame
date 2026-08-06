/**
 * Ops control for the sequence engine.
 *   GET  ?           -> status: engine on/off, sequences, queue counts
 *   POST {action}    -> seed | tick (dryRun supported) | activate | set_engine
 * Auth: x-ops-key; POST also needs ?confirm=1.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import { sqlite } from "@/lib/db";
import { runTick } from "@/modules/sequences/lib/engine";
import { seedSequences } from "@/modules/sequences/lib/seed";
import { queueCounts } from "@/modules/sequences/lib/queue";

export const dynamic = "force-dynamic";

function setSetting(key: string, value: string) {
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, type, module, updated_at) VALUES (?, ?, 'string', 'sequences', ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    )
    .run(key, value, new Date().toISOString());
}

export async function GET(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;
  const engine = (sqlite.prepare("SELECT value FROM settings WHERE key='seq.engine_enabled'").get() as { value: string } | undefined)?.value ?? "false";
  return NextResponse.json({
    ok: true,
    engineEnabled: engine === "true",
    sequences: sqlite.prepare(
      `SELECT s.name, s.brand, s.trigger, s.status, s.enrollment_mode, s.propose_only,
              (SELECT COUNT(*) FROM sequence_steps st WHERE st.sequence_id=s.id) AS steps,
              (SELECT COUNT(*) FROM sequence_enrollments e WHERE e.sequence_id=s.id AND e.status='active') AS active,
              (SELECT COUNT(*) FROM sequence_enrollments e WHERE e.sequence_id=s.id AND e.status='proposed') AS proposed
         FROM sequences s ORDER BY s.priority DESC`).all(),
    queue: queueCounts(),
  });
}

export async function POST(req: NextRequest) {
  const denied = requireOpsToken(req, { mutation: true });
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  switch (body.action) {
    case "seed":
      return NextResponse.json({ ok: true, ...seedSequences() });
    case "tick":
      return NextResponse.json({ ok: true, ...runTick({ dryRun: !!body.dryRun }) });
    case "set_engine":
      setSetting("seq.engine_enabled", body.enabled ? "true" : "false");
      return NextResponse.json({ ok: true, engineEnabled: !!body.enabled });
    case "activate": {
      if (!body.name) return NextResponse.json({ error: "name required" }, { status: 400 });
      sqlite.prepare("UPDATE sequences SET status=? WHERE name=?").run(body.status || "active", body.name);
      return NextResponse.json({ ok: true });
    }
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
}
