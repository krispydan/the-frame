/**
 * The daily review queue — the surface Christina actually works.
 *
 * The engine produces rows here; a human clears them. Everything needed to act
 * on a message travels with the row (body, thread deep link, attachment,
 * context about the shop) so clearing the queue never means going and looking
 * something up somewhere else. If this is slow, the whole engine stalls.
 */

import { sqlite } from "@/lib/db";

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
}

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
         JOIN companies c ON c.id = m.company_id
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
export function markSent(id: string, by: string, editedBody?: string): { ok: boolean } {
  const m = sqlite
    .prepare("SELECT * FROM sequence_messages WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (!m) return { ok: false };
  const at = new Date().toISOString();
  const body = editedBody ?? (m.rendered_body as string);
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
      .get(m.company_id as string, m.brand as string) as { retailer_token: string } | undefined;
    sqlite
      .prepare(
        `INSERT INTO outreach_messages
           (id, company_id, faire_retailer_id, brand, channel, direction, status, body, campaign, sent_at, source)
         VALUES (?, ?, ?, ?, ?, 'outbound', 'sent', ?, ?, ?, 'sequence_engine')`,
      )
      .run(crypto.randomUUID(), m.company_id, token?.retailer_token ?? null, m.brand, m.channel,
           body, m.sequence_id, at);
    sqlite
      .prepare("UPDATE company_faire_accounts SET last_messaged_at=? WHERE company_id=? AND brand=?")
      .run(at, m.company_id as string, m.brand as string);
  });
  tx();
  return { ok: true };
}

export function markSkipped(id: string, reason: string): { ok: boolean } {
  sqlite.prepare("UPDATE sequence_messages SET status='skipped', error=? WHERE id=?").run(reason, id);
  return { ok: true };
}

/** They replied — exit the whole enrollment, not just this step. */
export function markReplied(id: string): { ok: boolean } {
  const at = new Date().toISOString();
  const m = sqlite.prepare("SELECT enrollment_id FROM sequence_messages WHERE id=?").get(id) as { enrollment_id: string } | undefined;
  const tx = sqlite.transaction(() => {
    sqlite.prepare("UPDATE sequence_messages SET status='skipped', reply_detected_at=?, error='they replied' WHERE id=?").run(at, id);
    if (m) {
      sqlite.prepare("UPDATE sequence_enrollments SET status='exited_reply', exited_at=?, exit_reason='reply', next_step_due_at=NULL WHERE id=?")
        .run(at, m.enrollment_id);
    }
  });
  tx();
  return { ok: true };
}
