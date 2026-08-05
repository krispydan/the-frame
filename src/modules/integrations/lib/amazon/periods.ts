/**
 * Reporting periods.
 *
 * Month columns must be CONTIGUOUS. Deriving them from "months that have
 * data" drops a quiet month out of the middle, so a table reading
 * "Jun | Aug" looks like two consecutive months and a trend computed across
 * it is wrong by a whole period. A month with no sales is a fact worth
 * showing, not a row to skip.
 */

import { sqlite } from "@/lib/db";

/** First day of the month `n` months before `month` (YYYY-MM). */
function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** Inclusive first/last day of a YYYY-MM month. */
export function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  return { start: `${month}-01`, end: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}

/**
 * The last `count` months up to the most recent month with Amazon activity,
 * oldest first — contiguous, including months with nothing in them.
 *
 * Anchored on the latest month WITH data rather than on today, so a report
 * run on the 1st does not lead with an empty current month.
 */
export function recentAmazonMonths(count: number): string[] {
  const bounds = sqlite.prepare(`
    SELECT MIN(substr(date(purchase_date), 1, 7)) AS first,
           MAX(substr(date(purchase_date), 1, 7)) AS last
    FROM amazon_order_rows WHERE purchase_date IS NOT NULL
  `).get() as { first: string | null; last: string | null };

  if (!bounds.last || !bounds.first) return [];

  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const m = shiftMonth(bounds.last, -i);
    // Never invent months before the account existed — an empty column there
    // says "we sold nothing", when the truth is "we had not started".
    if (m >= bounds.first) out.push(m);
  }
  return out;
}
