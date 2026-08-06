/**
 * Outreach sequence engine — the tick.
 *
 * One idempotent pass, four stages: exit, enroll, advance, report. Everything
 * is re-derived from the database each run rather than driven by events, so a
 * missed tick, a crash, or a redeploy costs nothing — the next tick sees the
 * same truth and continues. (The in-process event bus is not durable, so
 * correctness never depends on it.)
 *
 * Nothing here sends. Advancing a step writes a sequence_messages row; a human
 * (queue page) or the runner (auto steps) does the sending. That separation is
 * what makes it safe to run the engine long before any send integration exists.
 *
 * Master switch: settings['seq.engine_enabled'] — OFF by default.
 * See docs/outreach-sequence-engine.md §3.
 */

import { sqlite } from "@/lib/db";
import { randomUUID } from "crypto";
import { renderTemplate } from "./render";
import { checkSuppression, lastOutreach } from "@/modules/sales/lib/suppression";

const now = () => new Date().toISOString();
const addDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * 86400000).toISOString();

export function getSetting(key: string, fallback: string): string {
  const r = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string | null } | undefined;
  return r?.value ?? fallback;
}
// A configured 0 must MEAN zero — `|| fallback` would turn "stop queueing"
// (review_daily_cap = 0) back into the default of 20.
const num = (key: string, fallback: number) => {
  const n = Number(getSetting(key, String(fallback)));
  return Number.isFinite(n) ? n : fallback;
};

export interface TickResult {
  enabled: boolean;
  exited: number;
  enrolled: number;
  proposed: number;
  queued: number;
  skippedRecent: number;
  errors: string[];
}

interface SequenceRow {
  id: string; name: string; brand: string; trigger: string; class: string; status: string;
  enrollment_mode: string; enrollment_rule: string | null;
  propose_only: number; priority: number; max_touches: number;
}
interface StepRow {
  id: string; sequence_id: string; step_no: number; delay_days: number;
  delay_business_days: number; channel: string; send_mode: string;
  template_subject: string | null; template_body: string;
  attachment_key: string | null; offer_code: string | null; task_note: string | null;
}

/** Skip weekends when a step asks for business-day spacing. */
function scheduleFrom(fromIso: string, step: StepRow): string {
  let d = new Date(Date.parse(fromIso) + step.delay_days * 86400000);
  if (step.delay_business_days) {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() + 86400000);
  }
  return d.toISOString();
}

export function runTick(opts: { dryRun?: boolean } = {}): TickResult {
  const res: TickResult = { enabled: false, exited: 0, enrolled: 0, proposed: 0, queued: 0, skippedRecent: 0, errors: [] };
  if (getSetting("seq.engine_enabled", "false") !== "true") return res;
  res.enabled = true;
  const dry = !!opts.dryRun;

  const sequences = sqlite
    .prepare("SELECT * FROM sequences WHERE status = 'active' ORDER BY priority DESC")
    .all() as SequenceRow[];
  if (!sequences.length) return res;

  const cooldownDays = num("seq.cooldown_days", 14);
  const crossBrandDays = num("seq.cross_brand_cooldown_days", 7);
  // This is a DAILY cap, and the tick runs every 5 minutes — so it has to be
  // measured against what today has already produced, not reset each tick.
  const dailyCap = num("seq.review_daily_cap", 20);
  const today = new Date().toISOString().slice(0, 10);
  const usedToday = (sqlite
    .prepare("SELECT COUNT(*) n FROM sequence_enrollments WHERE enrolled_by='rule' AND enrolled_at >= ?")
    .get(today) as { n: number }).n;
  const queuedToday = (sqlite
    .prepare("SELECT COUNT(*) n FROM sequence_messages WHERE queued_at >= ?")
    .get(today) as { n: number }).n;
  const enrollBudget = Math.max(0, dailyCap - usedToday);
  const queueBudget = Math.max(0, dailyCap - queuedToday);

  // ── 1. EXIT ────────────────────────────────────────────────────────────
  // They ordered, they replied, or they became suppressed. Checked before
  // anything else so we never queue a touch for someone who is already done.
  const active = sqlite
    .prepare("SELECT * FROM sequence_enrollments WHERE status IN ('active','paused_t0')")
    .all() as Array<{ id: string; sequence_id: string; company_id: string; enrolled_at: string; status: string }>;
  for (const e of active) {
    let reason: string | null = null;
    const ordered = sqlite
      .prepare(
        `SELECT 1 FROM orders WHERE company_id = ? AND placed_at > ?
           AND status NOT IN ('cancelled','returned') LIMIT 1`,
      )
      .get(e.company_id, e.enrolled_at);
    if (ordered) reason = "exited_order";
    if (!reason) {
      const replied = sqlite
        .prepare(
          `SELECT 1 FROM sequence_messages WHERE enrollment_id = ? AND reply_detected_at IS NOT NULL LIMIT 1`,
        )
        .get(e.id);
      if (replied) reason = "exited_reply";
    }
    if (!reason) {
      const seq = sequences.find((s) => s.id === e.sequence_id);
      if (checkSuppression(e.company_id, seq?.brand).suppressed) reason = "suppressed";
    }
    if (reason) {
      res.exited++;
      if (!dry) {
        const tx = sqlite.transaction(() => {
          sqlite.prepare("UPDATE sequence_enrollments SET status = ?, exited_at = ?, exit_reason = ?, next_step_due_at = NULL WHERE id = ?")
            .run(reason, now(), reason, e.id);
          // Void anything already waiting in the queue for this enrollment.
          // Otherwise a shop that just ordered, replied, or asked us to stop
          // still gets yesterday's drafted nudge when the queue is cleared.
          sqlite.prepare(
            `UPDATE sequence_messages SET status = 'skipped', error = ?
              WHERE enrollment_id = ? AND status IN ('queued_review','approved','task_open')`,
          ).run(`enrollment ${reason}`, e.id);
        });
        tx();
      }
    }
  }

  // Self-heal: an active enrollment with no due date and nothing outstanding in
  // the queue is finished — it just never got closed (a deleted step, a task
  // nobody actioned, an older bug). Left alone it would hold the
  // one-live-enrollment lock and quietly bar that company from every sequence.
  if (!dry) {
    sqlite.prepare(
      `UPDATE sequence_enrollments SET status='completed', exited_at=?, exit_reason='completed (no further steps)'
        WHERE status='active' AND next_step_due_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM sequence_messages m
                           WHERE m.enrollment_id = sequence_enrollments.id
                             AND m.status IN ('queued_review','approved','task_open'))`,
    ).run(now());
  }

  // ── 2. ENROLL ──────────────────────────────────────────────────────────
  // Highest-priority sequence wins a contested account; the unique index on
  // (company_id) WHERE active is the real guarantee, this just avoids churn.
  let enrolledThisTick = 0;
  for (const seq of sequences) {
    if (seq.enrollment_mode !== "auto") continue;
    if (enrolledThisTick >= enrollBudget) break;
    let candidates: string[] = [];
    try {
      candidates = findCandidates(seq);
    } catch (err) {
      res.errors.push(`${seq.name}: ${(err as Error).message}`);
      continue;
    }
    for (const companyId of candidates) {
      if (enrolledThisTick >= enrollBudget) break;
      // Already live in something?
      const busy = sqlite
        .prepare("SELECT 1 FROM sequence_enrollments WHERE company_id = ? AND status IN ('active','paused_t0') LIMIT 1")
        .get(companyId);
      if (busy) continue;
      // Same sequence in the last 90 days?
      // 'proposed' rows are shadow-mode records, not real touches. Counting them
      // here would mean two weeks of shadow running silently blocks every
      // candidate for 90 days the moment the sequence goes live.
      const recentSame = sqlite
        .prepare(
          `SELECT 1 FROM sequence_enrollments WHERE company_id = ? AND sequence_id = ?
             AND status != 'proposed' AND enrolled_at > ? LIMIT 1`,
        )
        .get(companyId, seq.id, addDays(now(), -90));
      if (recentSame) continue;
      if (checkSuppression(companyId, seq.brand).suppressed) continue;

      // Cooldown: hard per-brand for nudges, softer across brands. Relationship
      // sequences (welcome, review request) are exempt — they follow a real
      // event and should not be blocked by an unrelated nudge.
      if (seq.class === "nudge") {
        const last = lastOutreach(companyId);
        const sameBrand = last.byBrand[seq.brand];
        if (sameBrand && Date.parse(sameBrand) > Date.parse(addDays(now(), -cooldownDays))) { res.skippedRecent++; continue; }
        if (last.lastAnyAt && Date.parse(last.lastAnyAt) > Date.parse(addDays(now(), -crossBrandDays))) { res.skippedRecent++; continue; }
      }

      const proposed = seq.propose_only === 1;
      // Proposals count against the cap too, or shadow mode writes a row for
      // every candidate on every tick.
      enrolledThisTick++;
      if (proposed) res.proposed++; else res.enrolled++;
      // Don't stack duplicate proposals for the same account.
      if (proposed) {
        const already = sqlite
          .prepare("SELECT 1 FROM sequence_enrollments WHERE company_id=? AND sequence_id=? AND status='proposed' LIMIT 1")
          .get(companyId, seq.id);
        if (already) { res.proposed--; enrolledThisTick--; continue; }
      }
      if (!dry) {
        const firstStep = sqlite
          .prepare("SELECT * FROM sequence_steps WHERE sequence_id = ? ORDER BY step_no ASC LIMIT 1")
          .get(seq.id) as StepRow | undefined;
        sqlite
          .prepare(
            `INSERT INTO sequence_enrollments (id, sequence_id, company_id, status, current_step, next_step_due_at, enrolled_by, enrolled_at)
             VALUES (?, ?, ?, ?, 0, ?, 'rule', ?)`,
          )
          .run(randomUUID(), seq.id, companyId, proposed ? "proposed" : "active",
               firstStep ? scheduleFrom(now(), firstStep) : now(), now());
      }
    }
  }

  // ── 3. ADVANCE ─────────────────────────────────────────────────────────
  const due = sqlite
    .prepare(
      `SELECT * FROM sequence_enrollments
        WHERE status = 'active' AND next_step_due_at IS NOT NULL AND next_step_due_at <= ?
        ORDER BY next_step_due_at ASC LIMIT ?`,
    )
    .all(now(), queueBudget) as Array<{ id: string; sequence_id: string; company_id: string; current_step: number }>;

  for (const e of due) {
    // Load by id rather than from the active list: if the sequence was paused,
    // its enrollments must still be resolvable, or they sit active forever and
    // lock those companies out of everything else.
    const seq = (sequences.find((s) => s.id === e.sequence_id)
      || sqlite.prepare("SELECT * FROM sequences WHERE id = ?").get(e.sequence_id)) as SequenceRow | undefined;
    if (!seq) continue;
    if (seq.status === "paused") continue;          // hold, don't advance
    if (seq.status === "archived") {
      if (!dry) {
        sqlite.prepare("UPDATE sequence_enrollments SET status='completed', exited_at=?, exit_reason='sequence archived', next_step_due_at=NULL WHERE id=?")
          .run(now(), e.id);
      }
      continue;
    }
    // "The next step after this one" — not current+1. A deleted or renumbered
    // step would otherwise silently truncate the sequence.
    const step = sqlite
      .prepare("SELECT * FROM sequence_steps WHERE sequence_id = ? AND step_no > ? ORDER BY step_no ASC LIMIT 1")
      .get(seq.id, e.current_step) as StepRow | undefined;
    // No further step, or the touch cap is reached: this enrollment is done.
    if (!step || (seq.max_touches && step.step_no > seq.max_touches)) {
      if (!dry) {
        sqlite.prepare("UPDATE sequence_enrollments SET status='completed', exited_at=?, exit_reason='completed', next_step_due_at=NULL WHERE id=?")
          .run(now(), e.id);
      }
      continue;
    }

    let r: { text: string; missing: string[]; warnings: string[] };
    try {
      r = renderTemplate(step.template_body, { companyId: e.company_id, offerCode: step.offer_code });
    } catch (err) {
      // One unrenderable account must never stop the whole tick.
      res.errors.push(`render ${e.company_id}: ${(err as Error).message}`);
      continue;
    }
    // Fail closed: an unresolved merge field can never auto-send.
    const mode = r.missing.length && step.send_mode === "auto" ? "review" : step.send_mode;
    const status = mode === "task" ? "task_open" : mode === "auto" ? "approved" : "queued_review";

    const link = sqlite
      .prepare("SELECT retailer_token FROM company_faire_accounts WHERE company_id = ? AND brand = ?")
      .get(e.company_id, (seq.brand || "").toLowerCase()) as { retailer_token: string } | undefined;
    const threadUrl = step.channel === "faire" && link
      ? `https://www.faire.com/brand-portal/messages?retailerToken=${link.retailer_token}`
      : null;

    res.queued++;
    if (!dry) {
      const tx = sqlite.transaction(() => {
        sqlite
          .prepare(
            `INSERT OR IGNORE INTO sequence_messages
               (id, enrollment_id, step_id, sequence_id, company_id, brand, channel, status,
                rendered_subject, rendered_body, attachment_key, thread_url, queued_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(randomUUID(), e.id, step.id, seq.id, e.company_id, seq.brand, step.channel, status,
               step.template_subject, r.text, step.attachment_key, threadUrl, now());
        // Park the enrollment: the NEXT step is scheduled when THIS one is
        // actually sent (queue.ts), because delays anchor on completion. If we
        // scheduled from queue time, a queue cleared a week late would fire
        // touch 1 and touch 2 minutes apart.
        sqlite
          .prepare("UPDATE sequence_enrollments SET current_step = ?, next_step_due_at = NULL WHERE id = ?")
          .run(step.step_no, e.id);
      });
      try { tx(); } catch (err) { res.errors.push(`advance ${e.id}: ${(err as Error).message}`); }
    }
  }

  return res;
}

/**
 * Which accounts should enter this sequence right now. Each trigger is a plain
 * query over data we already keep, so eligibility is always re-derivable.
 */
function findCandidates(seq: SequenceRow): string[] {
  const limit = 200;
  switch (seq.trigger) {
    // T0 — first order placed, any status.
    case "T0":
      return (sqlite
        .prepare(
          `SELECT ca.company_id AS id FROM customer_accounts ca
            WHERE ca.total_orders = 1 AND ca.first_order_at > ?
            ORDER BY ca.first_order_at DESC LIMIT ?`,
        )
        .all(addDays(now(), -30), limit) as Array<{ id: string }>).map((r) => r.id);

    // T4 — review request. Delivery + 3 when we know delivery, else ship + 8.
    case "T4":
      return (sqlite
        .prepare(
          `SELECT DISTINCT o.company_id AS id FROM orders o
            WHERE o.company_id IS NOT NULL
              AND o.status NOT IN ('cancelled','returned')
              AND ((o.delivered_at IS NOT NULL AND o.delivered_at <= ? AND o.delivered_at > ?)
                OR (o.delivered_at IS NULL AND o.shipped_at IS NOT NULL AND o.shipped_at <= ? AND o.shipped_at > ?))
            LIMIT ?`,
        )
        .all(addDays(now(), -3), addDays(now(), -30), addDays(now(), -8), addDays(now(), -35), limit) as Array<{ id: string }>)
        .map((r) => r.id);

    // T1 — reorder due in 5 days. Gated on prediction confidence: at least
    // three orders, so the average gap means something.
    case "T1":
      return (sqlite
        .prepare(
          `SELECT ca.company_id AS id FROM customer_accounts ca
            WHERE ca.next_reorder_estimate IS NOT NULL
              AND ca.total_orders >= 3
              AND date(ca.next_reorder_estimate) <= date(?)
              AND date(ca.next_reorder_estimate) >= date(?)
            LIMIT ?`,
        )
        .all(addDays(now(), 5).slice(0, 10), now().slice(0, 10), limit) as Array<{ id: string }>).map((r) => r.id);

    // T6 — lapsed: past 1.5x their normal gap.
    case "T6":
      return (sqlite
        .prepare(
          `SELECT ca.company_id AS id FROM customer_accounts ca
            WHERE ca.total_orders >= 2 AND ca.last_order_at IS NOT NULL
              AND ca.next_reorder_estimate IS NOT NULL
              AND julianday('now') - julianday(ca.next_reorder_estimate) >
                  0.5 * (julianday(ca.next_reorder_estimate) - julianday(ca.last_order_at))
            LIMIT ?`,
        )
        .all(limit) as Array<{ id: string }>).map((r) => r.id);

    default:
      return [];
  }
}
