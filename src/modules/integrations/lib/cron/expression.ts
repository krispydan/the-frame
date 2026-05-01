/**
 * Minimal cron expression matcher — supports the 5-field syntax we use
 * (no seconds, no @yearly aliases). No external deps.
 *
 * Format: `minute hour day month day-of-week`
 *
 * Each field accepts:
 *   *           any value
 *   N           exact value
 *   N,M,K       comma-separated list
 *   N-M         inclusive range
 *   *\/N        every N starting from the field's minimum
 *   N-M/K       every K within the range
 *
 * Day-of-week: 0 or 7 = Sunday, 1 = Monday, ..., 6 = Saturday.
 *
 * Examples:
 *   "* * * * *"       every minute
 *   "0 14 * * *"      14:00 every day
 *   "0 15 * * 1"      15:00 every Monday
 *   "0,30 * * * *"    every minute 0 and 30 of every hour
 *   "*\/15 * * * *"   every 15 minutes
 *
 * Time zone: caller's responsibility. Pass a Date in the time zone you
 * want to evaluate. Most schedulers (including ours) operate in UTC and
 * cron expressions are intended in UTC unless stated otherwise.
 */

type Range = { min: number; max: number };

const FIELD_RANGES: Range[] = [
  { min: 0, max: 59 },  // minute
  { min: 0, max: 23 },  // hour
  { min: 1, max: 31 },  // day of month
  { min: 1, max: 12 },  // month
  { min: 0, max: 6 },   // day of week (0/7 both = Sunday — normalized below)
];

function parseField(field: string, range: Range): Set<number> {
  const result = new Set<number>();
  const parts = field.split(",");

  for (const part of parts) {
    if (part === "*") {
      for (let i = range.min; i <= range.max; i++) result.add(i);
      continue;
    }

    // Step syntax: "*/N" or "M-N/K"
    const stepMatch = part.match(/^(\*|\d+|\d+-\d+)\/(\d+)$/);
    if (stepMatch) {
      const head = stepMatch[1];
      const step = parseInt(stepMatch[2], 10);
      let lo: number, hi: number;
      if (head === "*") {
        lo = range.min;
        hi = range.max;
      } else if (head.includes("-")) {
        const [a, b] = head.split("-").map((n) => parseInt(n, 10));
        lo = a;
        hi = b;
      } else {
        lo = parseInt(head, 10);
        hi = range.max;
      }
      for (let i = lo; i <= hi; i += step) result.add(i);
      continue;
    }

    // Range: "M-N"
    if (part.includes("-")) {
      const [a, b] = part.split("-").map((n) => parseInt(n, 10));
      for (let i = a; i <= b; i++) result.add(i);
      continue;
    }

    // Single value
    const n = parseInt(part, 10);
    if (Number.isFinite(n)) result.add(n);
  }

  return result;
}

export type ParsedCron = {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** True when day-of-month or day-of-week was an explicit constraint
   *  (i.e. not "*"). Cron's OR-of-day rules: if both are explicit, match
   *  if either matches. If only one, match that one. If neither, match
   *  any day. */
  domExplicit: boolean;
  dowExplicit: boolean;
};

export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Cron expression must have 5 fields, got ${fields.length}: "${expr}"`);
  }

  const [m, h, dom, mon, dow] = fields;
  const result: ParsedCron = {
    minute: parseField(m, FIELD_RANGES[0]),
    hour: parseField(h, FIELD_RANGES[1]),
    dayOfMonth: parseField(dom, FIELD_RANGES[2]),
    month: parseField(mon, FIELD_RANGES[3]),
    dayOfWeek: parseField(dow, FIELD_RANGES[4]),
    domExplicit: dom !== "*",
    dowExplicit: dow !== "*",
  };

  // Normalize day-of-week: cron allows 7 = Sunday. JS uses 0-6 with 0=Sun.
  if (result.dayOfWeek.has(7)) {
    result.dayOfWeek.delete(7);
    result.dayOfWeek.add(0);
  }

  return result;
}

/**
 * Returns true when the given Date matches the parsed cron expression.
 * Date is evaluated in UTC by default (use the helper functions that get
 * UTC components below).
 */
export function matches(parsed: ParsedCron, date: Date): boolean {
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dayOfMonth = date.getUTCDate();
  const month = date.getUTCMonth() + 1;     // JS: 0-11, cron: 1-12
  const dayOfWeek = date.getUTCDay();       // JS: 0=Sun..6=Sat — matches cron

  if (!parsed.minute.has(minute)) return false;
  if (!parsed.hour.has(hour)) return false;
  if (!parsed.month.has(month)) return false;

  // Day matching: cron has a quirky OR rule when both are explicit
  const domMatches = parsed.dayOfMonth.has(dayOfMonth);
  const dowMatches = parsed.dayOfWeek.has(dayOfWeek);
  if (parsed.domExplicit && parsed.dowExplicit) return domMatches || dowMatches;
  if (parsed.domExplicit) return domMatches;
  if (parsed.dowExplicit) return dowMatches;
  return true;
}

export function matchesExpr(expr: string, date: Date = new Date()): boolean {
  return matches(parseCron(expr), date);
}
