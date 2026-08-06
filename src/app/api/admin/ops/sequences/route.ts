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
      if (!body.name && !body.seedKey) return NextResponse.json({ error: "name or seedKey required" }, { status: 400 });
      const status = body.status || "active";
      // A typo like "actve" previously deactivated a sequence and returned 200.
      const VALID = ["draft", "active", "paused", "archived"];
      if (!VALID.includes(status)) {
        return NextResponse.json({ error: `status must be one of ${VALID.join(", ")}` }, { status: 400 });
      }
      const r = body.seedKey
        ? sqlite.prepare("UPDATE sequences SET status=? WHERE seed_key=?").run(status, body.seedKey)
        : sqlite.prepare("UPDATE sequences SET status=? WHERE name=?").run(status, body.name);
      if (!r.changes) return NextResponse.json({ error: "no matching sequence" }, { status: 404 });
      return NextResponse.json({ ok: true, updated: r.changes, status });
    }
    case "set_propose_only": {
      if (!body.seedKey && !body.name) return NextResponse.json({ error: "name or seedKey required" }, { status: 400 });
      const v = body.proposeOnly === false ? 0 : 1;
      const r = body.seedKey
        ? sqlite.prepare("UPDATE sequences SET propose_only=? WHERE seed_key=?").run(v, body.seedKey)
        : sqlite.prepare("UPDATE sequences SET propose_only=? WHERE name=?").run(v, body.name);
      if (!r.changes) return NextResponse.json({ error: "no matching sequence" }, { status: 404 });
      return NextResponse.json({ ok: true, proposeOnly: v === 1 });
    }
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
}
