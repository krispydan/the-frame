/**
 * Time series for the Amazon dashboard.
 *
 * The reference dashboard shows weekly year-over-year lines. That needs a
 * prior year, and this account started selling in June — so the YoY series is
 * built but only EMITTED once there is a comparable period. An empty YoY
 * chart is worse than no chart: it reads as "we collapsed" rather than "we
 * did not exist yet". A rolling average carries the trend meanwhile.
 *
 * The daily table is a heatmap in the reference, coloured per column. Colour
 * is a rendering concern, but the PERCENTILE is not — computing it here means
 * every renderer shades the same way, and a column with no spread does not
 * get shaded at all rather than being painted arbitrarily.
 */

import { sqlite } from "@/lib/db";

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface AmazonDailyRow {
  date: string;
  units: number;
  freeUnits: number;
  grossSales: number;
  giveaway: number;
  netSales: number;
  orders: number;
  sessions: number;
  /** Units ordered ÷ sessions. Null when no sessions were recorded. */
  conversionPct: number | null;
  /** Average selling price on PAID units. Null when nothing was paid for. */
  asp: number | null;
}

export interface AmazonWeekRow {
  /** ISO-ish week start (Monday), YYYY-MM-DD. */
  weekStart: string;
  units: number;
  freeUnits: number;
  netSales: number;
  sessions: number;
  /** Trailing 4-week mean of netSales. Null until 4 weeks exist. */
  netSalesMa4: number | null;
  /** Same week last year, when there is one. */
  priorYearNetSales: number | null;
}

/** Per-column percentiles for the daily table, 0–1. */
export type HeatmapColumn = "units" | "netSales" | "sessions" | "conversionPct" | "asp";

export interface AmazonDashboardSeries {
  daily: AmazonDailyRow[];
  weekly: AmazonWeekRow[];
  /** date → column → percentile. Absent column means "do not shade". */
  heat: Record<string, Partial<Record<HeatmapColumn, number>>>;
  yoyAvailable: boolean;
  notes: string[];
}

/** Monday of the week containing `date`. */
function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/**
 * Percentile rank of each value within its column.
 *
 * Rank-based rather than min-max: one outlier day flattens a min-max scale so
 * every other day shades identically, which is exactly when a heatmap stops
 * being informative. Columns with fewer than 3 distinct values are left
 * unshaded — with two values, "highest" and "lowest" carry no signal.
 */
export function percentileRanks(values: Array<number | null>): Array<number | null> {
  const present = values.filter((v): v is number => v !== null);
  const distinct = new Set(present);
  if (distinct.size < 3) return values.map(() => null);

  const sorted = [...present].sort((a, b) => a - b);
  return values.map((v) => {
    if (v === null) return null;
    // Fraction of values strictly below, plus half the ties — so equal values
    // share a shade instead of one arbitrarily reading darker.
    const below = sorted.filter((x) => x < v).length;
    const equal = sorted.filter((x) => x === v).length;
    return Math.round(((below + equal / 2) / sorted.length) * 100) / 100;
  });
}

export function buildAmazonDashboardSeries(opts?: {
  days?: number;
  today?: string;
}): AmazonDashboardSeries {
  const days = opts?.days ?? 90;
  const today = opts?.today ?? new Date().toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86_400_000)
    .toISOString().slice(0, 10);

  const daily = sqlite.prepare(`
    WITH sales AS (
      SELECT date(r.purchase_date) AS d,
             IFNULL(SUM(r.item_price), 0) AS gross,
             IFNULL(SUM(r.item_promotion_discount + r.ship_promotion_discount), 0) AS giveaway,
             IFNULL(SUM(r.quantity), 0) AS units,
             IFNULL(SUM(CASE WHEN r.item_promotion_discount >= r.item_price - 0.005
                              AND r.item_price > 0.005 THEN r.quantity ELSE 0 END), 0) AS freeUnits,
             COUNT(DISTINCT r.amazon_order_id) AS orders
      FROM amazon_order_rows r
      WHERE date(r.purchase_date) BETWEEN ? AND ?
        AND IFNULL(LOWER(r.item_status), '') != 'cancelled'
      GROUP BY d
    ),
    traffic AS (
      SELECT date AS d, IFNULL(SUM(sessions), 0) AS sessions,
             IFNULL(SUM(units_ordered), 0) AS unitsOrdered
      FROM amazon_sales_traffic_daily WHERE date BETWEEN ? AND ?
      GROUP BY d
    )
    -- FULL OUTER via UNION: a day with traffic and no sales is a real and
    -- interesting day (people looked, nobody bought) and must not vanish.
    SELECT d,
           IFNULL(MAX(gross), 0) AS gross, IFNULL(MAX(giveaway), 0) AS giveaway,
           IFNULL(MAX(units), 0) AS units, IFNULL(MAX(freeUnits), 0) AS freeUnits,
           IFNULL(MAX(orders), 0) AS orders,
           IFNULL(MAX(sessions), 0) AS sessions, IFNULL(MAX(unitsOrdered), 0) AS unitsOrdered
    FROM (
      SELECT d, gross, giveaway, units, freeUnits, orders, 0 AS sessions, 0 AS unitsOrdered FROM sales
      UNION ALL
      SELECT d, 0, 0, 0, 0, 0, sessions, unitsOrdered FROM traffic
    )
    GROUP BY d ORDER BY d
  `).all(from, today, from, today) as Array<{
    d: string; gross: number; giveaway: number; units: number;
    freeUnits: number; orders: number; sessions: number; unitsOrdered: number;
  }>;

  const rows: AmazonDailyRow[] = daily.map((r) => {
    const netSales = round2(r.gross - r.giveaway);
    const paidUnits = r.units - r.freeUnits;
    return {
      date: r.d,
      units: r.units, freeUnits: r.freeUnits,
      grossSales: round2(r.gross), giveaway: round2(r.giveaway), netSales,
      orders: r.orders, sessions: r.sessions,
      conversionPct: r.sessions > 0 ? Math.round((r.unitsOrdered / r.sessions) * 1000) / 10 : null,
      // ASP over PAID units — including giveaways would drag it toward zero
      // and read as a price cut.
      asp: paidUnits > 0 ? round2(netSales / paidUnits) : null,
    };
  });

  // ── Heatmap percentiles, per column ──
  const cols: HeatmapColumn[] = ["units", "netSales", "sessions", "conversionPct", "asp"];
  const heat: AmazonDashboardSeries["heat"] = {};
  for (const col of cols) {
    const ranks = percentileRanks(rows.map((r) => r[col] as number | null));
    ranks.forEach((rank, i) => {
      if (rank === null) return;
      heat[rows[i].date] ??= {};
      heat[rows[i].date][col] = rank;
    });
  }

  // ── Weekly rollup ──
  const byWeek = new Map<string, AmazonWeekRow>();
  for (const r of rows) {
    const w = weekStart(r.date);
    const cur = byWeek.get(w) ?? {
      weekStart: w, units: 0, freeUnits: 0, netSales: 0, sessions: 0,
      netSalesMa4: null, priorYearNetSales: null,
    };
    cur.units += r.units;
    cur.freeUnits += r.freeUnits;
    cur.netSales = round2(cur.netSales + r.netSales);
    cur.sessions += r.sessions;
    byWeek.set(w, cur);
  }
  const weekly = [...byWeek.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  // Trailing 4-week mean. Null until four weeks exist rather than averaging
  // whatever is there — a "4-week average" over two weeks is a different
  // statistic wearing the same label.
  weekly.forEach((w, i) => {
    if (i < 3) return;
    const window = weekly.slice(i - 3, i + 1);
    w.netSalesMa4 = round2(window.reduce((t, x) => t + x.netSales, 0) / 4);
  });

  // ── Year over year, only where a prior year exists ──
  //
  // Offset by 52 WEEKS (364 days), not by a calendar year. Subtracting a year
  // from a Monday lands on a Sunday, so the prior-year week never matches the
  // current one and every comparison comes back null. 364 days preserves the
  // weekday, which is what a weekly YoY chart actually compares.
  const YOY_OFFSET_DAYS = 364;
  const shift = (date: string, days: number) =>
    new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

  const priorYear = sqlite.prepare(`
    SELECT date(r.purchase_date) AS d,
           IFNULL(SUM(r.item_price - r.item_promotion_discount - r.ship_promotion_discount), 0) AS net
    FROM amazon_order_rows r
    WHERE date(r.purchase_date) BETWEEN ? AND ?
      AND IFNULL(LOWER(r.item_status), '') != 'cancelled'
    GROUP BY d
  `).all(shift(from, YOY_OFFSET_DAYS), shift(today, YOY_OFFSET_DAYS)) as Array<{ d: string; net: number }>;

  const yoyAvailable = priorYear.length > 0;
  if (yoyAvailable) {
    const pyByWeek = new Map<string, number>();
    for (const p of priorYear) {
      const w = weekStart(p.d);
      pyByWeek.set(w, round2((pyByWeek.get(w) ?? 0) + p.net));
    }
    for (const w of weekly) {
      w.priorYearNetSales = pyByWeek.get(shift(w.weekStart, YOY_OFFSET_DAYS)) ?? null;
    }
  }

  const notes: string[] = [];
  if (!yoyAvailable) {
    notes.push(
      "No prior-year data, so there is no year-over-year line yet. It appears automatically once a " +
      "comparable period exists; until then the 4-week rolling average carries the trend.",
    );
  }
  if (rows.every((r) => r.sessions === 0)) {
    notes.push("No session data in this window — conversion is blank rather than zero.");
  }
  const unshaded = cols.filter((c) => !Object.values(heat).some((h) => h[c] !== undefined));
  if (unshaded.length > 0 && rows.length > 0) {
    notes.push(`Not shading ${unshaded.join(", ")} — too few distinct values for a percentile to mean anything.`);
  }

  return { daily: rows, weekly, heat, yoyAvailable, notes };
}
