/**
 * Step editor CRUD. Christina must be able to add a day-8 follow-up without a
 * code deploy — that was the biggest practical gap in the builder.
 *
 * Every write re-runs the voice lint and returns its warnings, so drift from
 * her house style shows up while she is editing rather than in a sent message.
 */
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { randomUUID } from "crypto";
import { lintTemplate } from "@/modules/sequences/lib/render";

export const dynamic = "force-dynamic";

const CHANNELS = ["faire", "email", "call", "direct_mail"];
const MODES = ["review", "auto", "task"];
const ATTACH_TYPES = ["", "file", "product", "collection"];

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const { action } = b as { action?: string };

  if (action === "create") {
    const { sequenceId } = b as { sequenceId?: string };
    if (!sequenceId) return NextResponse.json({ error: "sequenceId required" }, { status: 400 });
    const max = (sqlite.prepare("SELECT COALESCE(MAX(step_no),0) n FROM sequence_steps WHERE sequence_id=?")
      .get(sequenceId) as { n: number }).n;
    const id = randomUUID();
    sqlite.prepare(
      `INSERT INTO sequence_steps (id, sequence_id, step_no, delay_days, channel, send_mode, template_body)
       VALUES (?, ?, ?, ?, 'faire', 'review', ?)`,
    ).run(id, sequenceId, max + 1, max === 0 ? 0 : 7,
      "Hi {first_name},\n\nHope you are doing great! \n\nThanks again,\nChristina\nJaxy Eyewear");
    // Keep max_touches in step with reality, or the engine stops early.
    sqlite.prepare("UPDATE sequences SET max_touches = MAX(COALESCE(max_touches,0), ?) WHERE id = ?").run(max + 1, sequenceId);
    return NextResponse.json({ ok: true, id, stepNo: max + 1 });
  }

  if (action === "update") {
    const { id, patch } = b as { id?: string; patch?: Record<string, unknown> };
    if (!id || !patch) return NextResponse.json({ error: "id and patch required" }, { status: 400 });
    if (patch.channel && !CHANNELS.includes(String(patch.channel))) {
      return NextResponse.json({ error: `channel must be one of ${CHANNELS.join(", ")}` }, { status: 400 });
    }
    if (patch.send_mode && !MODES.includes(String(patch.send_mode))) {
      return NextResponse.json({ error: `send_mode must be one of ${MODES.join(", ")}` }, { status: 400 });
    }
    if (patch.attachment_type !== undefined && !ATTACH_TYPES.includes(String(patch.attachment_type ?? ""))) {
      return NextResponse.json({ error: "attachment_type must be file, product or collection" }, { status: 400 });
    }
    const ALLOWED = ["delay_days", "delay_business_days", "channel", "send_mode", "template_body",
      "template_subject", "attachment_type", "attachment_ref", "attachment_label", "offer_code", "task_note"];
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!ALLOWED.includes(k)) continue;
      sets.push(`${k} = ?`); vals.push(v === "" ? null : v);
    }
    if (!sets.length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    vals.push(id);
    const r = sqlite.prepare(`UPDATE sequence_steps SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    if (!r.changes) return NextResponse.json({ error: "no such step" }, { status: 404 });
    const row = sqlite.prepare("SELECT template_body FROM sequence_steps WHERE id=?").get(id) as { template_body: string };
    return NextResponse.json({ ok: true, warnings: lintTemplate(row.template_body) });
  }

  if (action === "delete") {
    const { id } = b as { id?: string };
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const step = sqlite.prepare("SELECT sequence_id, step_no FROM sequence_steps WHERE id=?")
      .get(id) as { sequence_id: string; step_no: number } | undefined;
    if (!step) return NextResponse.json({ error: "no such step" }, { status: 404 });
    // Enrollments mid-flight track position by step_no, so renumber the rest
    // down instead of leaving a hole in the chain.
    const tx = sqlite.transaction(() => {
      sqlite.prepare("DELETE FROM sequence_steps WHERE id=?").run(id);
      sqlite.prepare("UPDATE sequence_steps SET step_no = step_no - 1 WHERE sequence_id=? AND step_no > ?")
        .run(step.sequence_id, step.step_no);
      const n = (sqlite.prepare("SELECT COUNT(*) n FROM sequence_steps WHERE sequence_id=?")
        .get(step.sequence_id) as { n: number }).n;
      sqlite.prepare("UPDATE sequences SET max_touches=? WHERE id=?").run(n, step.sequence_id);
    });
    tx();
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
