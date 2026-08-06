/**
 * Sequence performance. Deliberately few numbers, and each one is a decision:
 * reply rate says "is the copy working", order-within-30d says "is it earning",
 * skip rate says "is Christina rejecting what the engine picks".
 *
 * Attribution rule, applied identically everywhere: an order counts for an
 * enrollment when it lands within 30 days of that enrollment's LAST SENT touch.
 * One rule, written once, so two screens can't disagree.
 */

import { sqlite } from "@/lib/db";

export interface SequenceMetrics {
  sequenceId: string;
  enrolled: number;
  active: number;
  proposed: number;
  sent: number;
  skipped: number;
  replied: number;
  ordered: number;
  revenue: number;
  replyRate: number;
  orderRate: number;
  editRate: number;
}

export function sequenceMetrics(sequenceId: string): SequenceMetrics {
  const one = (sql: string, ...p: unknown[]) => (sqlite.prepare(sql).get(...p) as { n: number }).n || 0;

  const enrolled = one("SELECT COUNT(*) n FROM sequence_enrollments WHERE sequence_id = ?", sequenceId);
  const active = one("SELECT COUNT(*) n FROM sequence_enrollments WHERE sequence_id = ? AND status = 'active'", sequenceId);
  const proposed = one("SELECT COUNT(*) n FROM sequence_enrollments WHERE sequence_id = ? AND status = 'proposed'", sequenceId);
  const sent = one("SELECT COUNT(*) n FROM sequence_messages WHERE sequence_id = ? AND status = 'sent'", sequenceId);
  const skipped = one("SELECT COUNT(*) n FROM sequence_messages WHERE sequence_id = ? AND status = 'skipped'", sequenceId);
  const replied = one(
    "SELECT COUNT(DISTINCT company_id) n FROM sequence_messages WHERE sequence_id = ? AND reply_detected_at IS NOT NULL",
    sequenceId,
  );
  const edits = one("SELECT COUNT(*) n FROM sequence_messages WHERE sequence_id = ? AND edited = 1", sequenceId);

  // Orders within 30 days of the last sent touch for that enrollment.
  const orders = sqlite
    .prepare(
      `SELECT COUNT(DISTINCT o.id) AS n, COALESCE(SUM(o.total), 0) AS revenue
         FROM sequence_messages m
         JOIN orders o ON o.company_id = m.company_id
        WHERE m.sequence_id = ? AND m.status = 'sent' AND m.sent_at IS NOT NULL
          AND o.placed_at > m.sent_at
          AND julianday(o.placed_at) - julianday(m.sent_at) <= 30
          AND o.status NOT IN ('cancelled','returned')`,
    )
    .get(sequenceId) as { n: number; revenue: number };

  const touched = sent || 1;
  return {
    sequenceId, enrolled, active, proposed, sent, skipped, replied,
    ordered: orders.n || 0,
    revenue: orders.revenue || 0,
    replyRate: Math.round((replied / touched) * 1000) / 10,
    orderRate: Math.round(((orders.n || 0) / touched) * 1000) / 10,
    editRate: Math.round((edits / touched) * 1000) / 10,
  };
}

/** Who is currently in this sequence, and where. Powers the detail page. */
export function sequenceEnrollments(sequenceId: string, limit = 100) {
  return sqlite
    .prepare(
      `SELECT e.id, e.status, e.current_step, e.next_step_due_at, e.enrolled_at, e.exit_reason,
              c.name AS company_name, c.city, c.state, c.id AS company_id
         FROM sequence_enrollments e
         JOIN companies c ON c.id = e.company_id
        WHERE e.sequence_id = ?
        ORDER BY CASE e.status WHEN 'active' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END,
                 e.enrolled_at DESC
        LIMIT ?`,
    )
    .all(sequenceId, limit) as Array<{
      id: string; status: string; current_step: number; next_step_due_at: string | null;
      enrolled_at: string; exit_reason: string | null; company_name: string;
      city: string | null; state: string | null; company_id: string;
    }>;
}
