/**
 * The daily review queue — the surface Christina actually works.
 *
 * The engine produces rows here; a human clears them. Everything needed to act
 * on a message travels with the row (body, thread deep link, attachment,
 * context about the shop) so clearing the queue never means going and looking
 * something up somewhere else. If this is slow, the whole engine stalls.
 */

import { sqlite } from "@/lib/db";
import { randomUUID } from "crypto";
import { checkSuppression, setDoNotContact } from "@/modules/sales/lib/suppression";

export interface QueueItem {
  id: string;
  companyId: string;
  companyName: string;
  city: string | null;
  state: string | null;
  sequenceName: string;
  brand: string;
  channel: string;
  stepNo: number;
  status: string;
  subject: string | null;
  body: string;
  threadUrl: string | null;
  attachmentKey: string | null;
  queuedAt: string;
  edited: number;
  // context
  lastOrderAt: string | null;
  totalOrders: number | null;
  tier: string | null;
  lastMessagedAt: string | null;
  /** Tokens still unfilled in the body. Non-empty = must not be sent as-is. */
  unresolved: string[];
}

/** One place that knows how a follow-up is scheduled. Was duplicated across
 *  the engine, markSent and markSkipped, and the copies had already drifted. */
function scheduleNext(enrollmentId: string, stepId: string, fromIso: string): void {
  const step = sqlite.prepare("SELECT sequence_id, step_no FROM sequence_steps WHERE id = ?")
    .get(stepId) as { sequence_id: string; step_no: number } | undefined;
  const done = () => sqlite
    .prepare("UPDATE sequence_enrollments SET status='completed', exited_at=?, exit_reason='completed', next_step_due_at=NULL WHERE id=? AND status IN ('active','paused_t0')")
    .run(fromIso, enrollmentId);
  // A missing step row must complete the enrollment, never leave it parked —
  // an enrollment stuck active with no due date locks the company out of every
  // sequence via the one-live-enrollment index.
  if (!step) { done(); return; }
  const next = sqlite
    .prepare("SELECT delay_days, delay_business_days FROM sequence_steps WHERE sequence_id=? AND step_no>? ORDER BY step_no ASC LIMIT 1")
    .get(step.sequence_id, step.step_no) as { delay_days: number; delay_business_days: number } | undefined;
  if (!next) { done(); return; }
  let due = new Date(Date.parse(fromIso) + (next.delay_days || 0) * 86400000);
  if (next.delay_business_days) {
    while (due.getUTCDay() === 0 || due.getUTCDay() === 6) due = new Date(due.getTime() + 86400000);
  }
  sqlite.prepare("UPDATE sequence_enrollments SET next_step_due_at=? WHERE id=? AND status IN ('active','paused_t0')")
    .run(due.toISOString(), enrollmentId);
}

/** Statuses a queue item can still be acted on from. */
const ACTIONABLE = ["queued_review", "approved", "task_open"];

export function getQueue(opts: { limit?: number; brand?: string; status?: string } = {}): QueueItem[] {
  const limit = opts.limit ?? 100;
  const status = opts.status ?? "queued_review";
  const params: unknown[] = [status];
  let brandFilter = "";
  if (opts.brand) { brandFilter = "AND m.brand = ?"; params.push(opts.brand); }
  params.push(limit);

  const rows = sqlite
    .prepare(
      `SELECT m.id, m.company_id, m.brand, m.channel, m.status, m.rendered_subject, m.rendered_body,
              m.thread_url, m.attachment_key, m.queued_at, m.edited,
              c.name AS company_name, c.city, c.state,
              s.name AS sequence_name, st.step_no,
              ca.last_order_at, ca.total_orders, ca.tier,
              (SELECT MAX(sent_at) FROM outreach_messages om WHERE om.company_id = m.company_id) AS last_messaged_at
         FROM sequence_messages m
         LEFT JOIN companies c ON c.id = m.company_id
         LEFT JOIN sequences s ON s.id = m.sequence_id
         LEFT JOIN sequence_steps st ON st.id = m.step_id
         LEFT JOIN customer_accounts ca ON ca.company_id = m.company_id
        WHERE m.status = ? ${brandFilter}
        ORDER BY m.queued_at ASC
        LIMIT ?`,
    )
    .all(...params) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: r.id as string,
    companyId: r.company_id as string,
    companyName: (r.company_name as string) || "(unknown)",
    city: r.city as string | null,
    state: r.state as string | null,
    sequenceName: (r.sequence_name as string) || "(sequence)",
    brand: (r.brand as string) || "",
    channel: (r.channel as string) || "faire",
    stepNo: (r.step_no as number) ?? 1,
    status: r.status as string,
    subject: r.rendered_subject as string | null,
    body: r.rendered_body as string,
    threadUrl: r.thread_url as string | null,
    attachmentKey: r.attachment_key as string | null,
    queuedAt: r.queued_at as string,
    edited: (r.edited as number) || 0,
    lastOrderAt: r.last_order_at as string | null,
    totalOrders: r.total_orders as number | null,
    tier: r.tier as string | null,
    lastMessagedAt: r.last_messaged_at as string | null,
    unresolved: [...new Set(((r.rendered_body as string) || "").match(/\{(\w+)\}/g) || [])],
  }));
}

export function queueCounts(): { review: number; tasks: number; approved: number; sentToday: number } {
  const one = (sql: string, ...p: unknown[]) => (sqlite.prepare(sql).get(...p) as { n: number }).n;
  const today = new Date().toISOString().slice(0, 10);
  return {
    review: one("SELECT COUNT(*) n FROM sequence_messages WHERE status = 'queued_review'"),
    tasks: one("SELECT COUNT(*) n FROM sequence_messages WHERE status = 'task_open'"),
    approved: one("SELECT COUNT(*) n FROM sequence_messages WHERE status = 'approved'"),
    sentToday: one("SELECT COUNT(*) n FROM sequence_messages WHERE status = 'sent' AND sent_at >= ?", today),
  };
}

/**
 * Mark an item sent. Also writes the shared outreach_messages ledger, which is
 * what every cooldown and the "never double-touch" rule reads — the sequence
 * table alone would leave those blind to sequence sends.
 */
export function markSent(id: string, by: string, editedBody?: string): { ok: boolean; reason?: string } {
  const m = sqlite
    .prepare("SELECT * FROM sequence_messages WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (!m) return { ok: false, reason: "not_found" };

  // Idempotent, and only from a state that can still be acted on. Two tabs
  // open meant one could re-send a row a colleague had just skipped.
  if (m.status === "sent") return { ok: true };
  if (!ACTIONABLE.includes(m.status as string)) {
    return { ok: false, reason: `already ${m.status}` };
  }

  const at = new Date().toISOString();
  const body = editedBody ?? (m.rendered_body as string);

  // LAST GATE. This row may have been rendered days ago; a lot can change in
  // between, and the queue is the final point where we can still decline.
  const sup = checkSuppression(m.company_id as string, (m.brand as string) || undefined);
  if (sup.suppressed) {
    sqlite.prepare("UPDATE sequence_messages SET status='skipped', error=? WHERE id=?")
      .run(`suppressed: ${sup.reason}`, id);
    return { ok: false, reason: `suppressed: ${sup.reason}` };
  }
  const enr = sqlite
    .prepare("SELECT status FROM sequence_enrollments WHERE id = ?")
    .get(m.enrollment_id as string) as { status: string } | undefined;
  if (enr && !["active", "paused_t0"].includes(enr.status)) {
    sqlite.prepare("UPDATE sequence_messages SET status='skipped', error=? WHERE id=?")
      .run(`enrollment ${enr.status}`, id);
    return { ok: false, reason: `enrollment ${enr.status}` };
  }
  // An unresolved merge field must never reach a retailer. The body is
  // editable right there in the queue, so this is a fixable stop, not a dead end.
  if (/\{\w+\}/.test(body)) {
    return { ok: false, reason: "unresolved merge field — edit the message before sending" };
  }
  const tx = sqlite.transaction(() => {
    sqlite
      .prepare(
        `UPDATE sequence_messages
            SET status='sent', sent_at=?, sent_by=?, rendered_body=?, edited=?
          WHERE id=?`,
      )
      .run(at, by, body, editedBody && editedBody !== m.rendered_body ? 1 : (m.edited as number) || 0, id);
    const token = sqlite
      .prepare("SELECT retailer_token FROM company_faire_accounts WHERE company_id=? AND brand=?")
      .get(m.company_id as string, ((m.brand as string) || "").toLowerCase()) as { retailer_token: string } | undefined;
    sqlite
      .prepare(
        `INSERT INTO outreach_messages
           (id, company_id, faire_retailer_id, brand, channel, direction, status, body, campaign, sent_at, source)
         VALUES (?, ?, ?, ?, ?, 'outbound', 'sent', ?, ?, ?, 'sequence_engine')`,
      )
      .run(randomUUID(), m.company_id, token?.retailer_token ?? null, m.brand, m.channel,
           body, m.sequence_id, at);
    sqlite
      .prepare("UPDATE company_faire_accounts SET last_messaged_at=? WHERE company_id=? AND brand=?")
      .run(at, m.company_id as string, ((m.brand as string) || "").toLowerCase());

    // Schedule the NEXT step from this send — delays anchor on completion, so
    // a queue cleared late shifts the whole follow-up chain with it.
    scheduleNext(m.enrollment_id as string, m.step_id as string, at);
  });
  tx();
  return { ok: true };
}

export function markSkipped(id: string, reason: string): { ok: boolean; reason?: string } {
  const m = sqlite.prepare("SELECT enrollment_id, step_id, status FROM sequence_messages WHERE id=?")
    .get(id) as { enrollment_id: string; step_id: string; status: string } | undefined;
  if (!m) return { ok: false, reason: "not_found" };
  if (!ACTIONABLE.includes(m.status)) return { ok: false, reason: `already ${m.status}` };
  const tx = sqlite.transaction(() => {
    sqlite.prepare("UPDATE sequence_messages SET status='skipped', error=? WHERE id=?").run(reason, id);
    // Skipping one touch must not strand the enrollment.
    scheduleNext(m.enrollment_id, m.step_id, new Date().toISOString());
  });
  tx();
  return { ok: true };
}

/**
 * "Take us off your list." Suppresses the shop globally, voids this message and
 * exits the enrollment. Without this she had no way in the product to honour an
 * opt-out — the one request that most needs to be easy to act on.
 */
export function markDoNotContact(id: string, reason = "asked us to stop"): { ok: boolean; reason?: string } {
  const m = sqlite.prepare("SELECT enrollment_id, company_id, status FROM sequence_messages WHERE id=?")
    .get(id) as { enrollment_id: string; company_id: string; status: string } | undefined;
  if (!m) return { ok: false, reason: "not_found" };
  const at = new Date().toISOString();
  const tx = sqlite.transaction(() => {
    setDoNotContact(m.company_id, reason);
    sqlite.prepare("UPDATE sequence_messages SET status='skipped', error=? WHERE id=? AND status IN ('queued_review','approved','task_open')")
      .run(`do not contact: ${reason}`, id);
    sqlite.prepare("UPDATE sequence_enrollments SET status='suppressed', exited_at=?, exit_reason='do not contact', next_step_due_at=NULL WHERE id=?")
      .run(at, m.enrollment_id);
  });
  tx();
  return { ok: true };
}

/** A call/direct-mail task is done — advance the chain like a send would. */
export function markTaskDone(id: string): { ok: boolean; reason?: string } {
  const m = sqlite.prepare("SELECT enrollment_id, step_id, status FROM sequence_messages WHERE id=?")
    .get(id) as { enrollment_id: string; step_id: string; status: string } | undefined;
  if (!m) return { ok: false, reason: "not_found" };
  if (m.status !== "task_open") return { ok: false, reason: `already ${m.status}` };
  const at = new Date().toISOString();
  const tx = sqlite.transaction(() => {
    sqlite.prepare("UPDATE sequence_messages SET status='task_done', sent_at=? WHERE id=?").run(at, id);
    scheduleNext(m.enrollment_id, m.step_id, at);
  });
  tx();
  return { ok: true };
}

/** They replied — exit the whole enrollment, not just this step. */
export function markReplied(id: string): { ok: boolean; reason?: string } {
  const at = new Date().toISOString();
  const m = sqlite.prepare("SELECT enrollment_id, status FROM sequence_messages WHERE id=?")
    .get(id) as { enrollment_id: string; status: string } | undefined;
  if (!m) return { ok: false, reason: "not_found" };
  if (!ACTIONABLE.includes(m.status)) return { ok: false, reason: `already ${m.status}` };
  const tx = sqlite.transaction(() => {
    sqlite.prepare("UPDATE sequence_messages SET status='skipped', reply_detected_at=?, error='they replied' WHERE id=?").run(at, id);
    // Only exit a LIVE enrollment — never rewrite one that already exited for
    // another reason (an order), which would lose that attribution.
    sqlite.prepare("UPDATE sequence_enrollments SET status='exited_reply', exited_at=?, exit_reason='reply', next_step_due_at=NULL WHERE id=? AND status IN ('active','paused_t0')")
      .run(at, m.enrollment_id);
  });
  tx();
  return { ok: true };
}
