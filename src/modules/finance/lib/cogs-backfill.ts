/**
 * COGS backfill + correction engine.
 *
 * Three operations on top of the daily job:
 *   - runCogsBackfill  — replay runDailyCogsPosting across a date range
 *                        (go-live history, or after seeding layers).
 *   - correctCogsForDate — reverse a day's posted journal and re-post fresh
 *                        (landed-cost true-up, fixed data). Reverse-and-repost,
 *                        never edit-in-place. Locked-period aware.
 *   - resolveException — re-run a single day so a fixed exception flows in.
 */
import { sqlite } from "@/lib/db";
import { calculateCogs } from "./fifo-engine";
import { runDailyCogsPosting, buildDailyCogsJournal, type DailyCogsResult } from "./daily-cogs";
import { postManualJournal } from "./xero-client";
import { notifyCogsCorrected } from "@/modules/integrations/lib/slack/notifications";

/** Inclusive list of YYYY-MM-DD dates from `from` to `to`. */
function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  // Guard against an inverted or absurd range.
  let guard = 0;
  while (d <= end && guard < 1000) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
    guard++;
  }
  return out;
}

export interface BackfillResult {
  from: string;
  to: string;
  dryRun: boolean;
  days: DailyCogsResult[];
  totalCogs: number;
  totalUnits: number;
  totalExceptions: number;
}

/** Replay the daily COGS job for each day in [from, to]. */
export async function runCogsBackfill(opts: {
  from: string; to: string; dryRun?: boolean; force?: boolean;
}): Promise<BackfillResult> {
  const dryRun = !!opts.dryRun;
  const days: DailyCogsResult[] = [];
  for (const date of dateRange(opts.from, opts.to)) {
    const r = await runDailyCogsPosting({ date, dryRun, force: opts.force });
    days.push(r);
  }
  return {
    from: opts.from, to: opts.to, dryRun,
    days,
    totalCogs: Math.round(days.reduce((s, d) => s + d.totalCogs, 0) * 100) / 100,
    totalUnits: days.reduce((s, d) => s + d.unitsCosted, 0),
    totalExceptions: days.reduce((s, d) => s + d.exceptions.length, 0),
  };
}

/** The Xero period-lock date (YYYY-MM-DD), if set. Postings dated on/before
 *  this must land in the current open period, not reopen a closed month. */
function getPeriodLockDate(): string | null {
  const row = sqlite.prepare(
    "SELECT value FROM settings WHERE key = 'xero_period_lock_date' LIMIT 1",
  ).get() as { value: string } | undefined;
  return row?.value || null;
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Restore consumed quantity to layers and delete a day's depletions so the
 *  day can be re-costed from scratch. */
function unwindDepletionsForDay(date: string): number {
  const dayStart = `${date}T00:00:00`;
  const dayEnd = `${date}T23:59:59.999`;
  const deps = sqlite.prepare(
    "SELECT id, cost_layer_id, quantity FROM inventory_cost_depletions WHERE depleted_at >= ? AND depleted_at <= ?",
  ).all(dayStart, dayEnd) as Array<{ id: string; cost_layer_id: string; quantity: number }>;

  const restore = sqlite.prepare("UPDATE inventory_cost_layers SET remaining_quantity = remaining_quantity + ? WHERE id = ?");
  const del = sqlite.prepare("DELETE FROM inventory_cost_depletions WHERE id = ?");
  const tx = sqlite.transaction((rows: typeof deps) => {
    for (const d of rows) {
      restore.run(d.quantity, d.cost_layer_id);
      del.run(d.id);
    }
  });
  tx(deps);
  return deps.length;
}

export interface CorrectionResult {
  date: string;
  reversedJournalId: string | null;
  newResult: DailyCogsResult | null;
  postedInPeriod: string;
  note?: string;
}

/**
 * Reverse a day's posted COGS journal and re-post fresh from current layers.
 * Used for landed-cost true-ups (freight/duty bill arrived later) and data
 * fixes. Never edits the original journal — posts a reversing journal, then a
 * new one. If the day falls in a Xero-locked period, both land in today's
 * (open) period with the original date referenced in the narration.
 */
export async function correctCogsForDate(
  date: string,
  opts: { reason?: string } = {},
): Promise<CorrectionResult> {
  const reason = opts.reason || "Manual correction / landed-cost true-up";
  const lockDate = getPeriodLockDate();
  const locked = !!lockDate && date <= lockDate;
  const postDate = locked ? todayUTC() : date;
  const note = locked
    ? `Original day ${date} is in a locked period (lock ${lockDate}); reversal + re-post booked in the current period (${postDate}).`
    : undefined;

  // 1. Reverse the existing posting (based on what's currently booked for the day).
  const existingCalc = calculateCogs(date, date);
  let reversedJournalId: string | null = null;
  if (existingCalc.totalCogs > 0) {
    const reversal = await buildDailyCogsJournal(date, existingCalc, { reverse: true, postDate });
    const post = await postManualJournal(reversal);
    if (!post.success) throw new Error(`Reversal post failed: ${post.error}`);
    reversedJournalId = post.manualJournalId;
  }

  // 2. Mark the prior journal row reconciled/superseded + unwind depletions.
  sqlite.prepare(
    "UPDATE cogs_journals SET status = 'reconciled', notes = COALESCE(notes,'') || ' [reversed: ' || ? || ']' WHERE week_start = ? AND week_end = ? AND status = 'posted'",
  ).run(reversedJournalId ?? "n/a", date, date);
  unwindDepletionsForDay(date);

  // 3. Re-run the day fresh (force past the idempotency guard). When the
  //    original day is locked, post the fresh journal into the current period
  //    via postDate; otherwise keep it dated to the original day.
  const newResult = await runDailyCogsPosting({
    date, force: true, postDate: locked ? postDate : undefined,
  });

  await notifyCogsCorrected({
    date, reason,
    reversedJournalId,
    newJournalId: newResult?.xeroJournalId ?? null,
    newTotal: newResult?.totalCogs ?? 0,
    currency: "USD",
    postedInPeriodNote: note,
  }).catch(() => {});

  return { date, reversedJournalId, newResult, postedInPeriod: postDate, note };
}

/**
 * Re-run the day an open exception belongs to so a now-fixed line flows in.
 * Marks the exception resolved if its order line costs cleanly this time.
 */
export async function resolveException(exceptionId: string): Promise<{
  resolved: boolean; date: string | null; result: DailyCogsResult | null;
}> {
  const ex = sqlite.prepare(
    "SELECT id, order_item_id, created_at, run_id FROM cogs_exceptions WHERE id = ? AND status = 'open'",
  ).get(exceptionId) as { id: string; order_item_id: string | null; created_at: string } | undefined;
  if (!ex || !ex.order_item_id) return { resolved: false, date: null, result: null };

  // Find the shipped date of the order line so we re-run the right day.
  const line = sqlite.prepare(
    `SELECT o.shipped_at AS shippedAt FROM order_items oi JOIN orders o ON oi.order_id = o.id WHERE oi.id = ?`,
  ).get(ex.order_item_id) as { shippedAt: string | null } | undefined;
  const date = line?.shippedAt ? line.shippedAt.slice(0, 10) : null;
  if (!date) return { resolved: false, date: null, result: null };

  // correctCogsForDate re-deplete the whole day (force), which re-evaluates
  // the line and auto-resolves the exception on success.
  const correction = await correctCogsForDate(date, { reason: `Resolve exception ${exceptionId}` });
  const stillOpen = sqlite.prepare(
    "SELECT id FROM cogs_exceptions WHERE id = ? AND status = 'open'",
  ).get(exceptionId) as { id: string } | undefined;

  return { resolved: !stillOpen, date, result: correction.newResult };
}
