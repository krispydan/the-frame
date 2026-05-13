export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET /api/v1/finance/trajectory
 *
 * Time-series aggregates for the finance dashboard trajectory charts.
 * Returns:
 *   - monthly: last 12 months of orders revenue + count + AOV per channel
 *               (rolling window from today; zero-filled so the chart axis is
 *               continuous even when a month has no orders)
 *   - weekly:  last 12 weeks of the same metrics (Mon-start weeks, UTC)
 *   - mom:     this month vs last month KPIs (revenue, orders, AOV) with %
 *               deltas — convenient for the at-a-glance cards
 *   - channels: distinct channel names present in the 12-month window so the
 *               UI can build the legend without scanning every row
 *
 * Excludes orders with status=cancelled.
 */

interface Bucket {
  key: string;          // "YYYY-MM" for monthly, "YYYY-MM-DD" (Monday) for weekly
  label: string;        // display label
  revenue: number;
  orders: number;
  byChannel: Record<string, number>;
}

interface AggregateRow {
  bucket: string;
  channel: string;
  revenue: number;
  orders: number;
}

function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function startOfIsoWeekUtc(d: Date): Date {
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = (day + 6) % 7; // days since Monday
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  out.setUTCDate(out.getUTCDate() - diff);
  return out;
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function monthLabel(d: Date): string {
  return d.toLocaleString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
}

function weekLabel(d: Date): string {
  // e.g. "Apr 29"
  return d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export async function GET() {
  const now = new Date();
  const thisMonthStart = startOfMonthUtc(now);

  // Window: 12 months including current
  const monthsBack = 12;
  const months: Date[] = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const m = new Date(Date.UTC(thisMonthStart.getUTCFullYear(), thisMonthStart.getUTCMonth() - i, 1));
    months.push(m);
  }
  const monthlyWindowStart = months[0];

  // Window: 12 weeks including current
  const weeksBack = 12;
  const thisWeekStart = startOfIsoWeekUtc(now);
  const weeks: Date[] = [];
  for (let i = weeksBack - 1; i >= 0; i--) {
    const w = new Date(thisWeekStart);
    w.setUTCDate(w.getUTCDate() - i * 7);
    weeks.push(w);
  }
  const weeklyWindowStart = weeks[0];

  // ── Monthly aggregate (per channel) ──
  const monthlyRows = sqlite
    .prepare(
      `SELECT strftime('%Y-%m', placed_at) AS bucket,
              channel,
              SUM(total) AS revenue,
              COUNT(*) AS orders
       FROM orders
       WHERE placed_at IS NOT NULL
         AND placed_at >= ?
         AND (status IS NULL OR status != 'cancelled')
       GROUP BY bucket, channel`,
    )
    .all(monthlyWindowStart.toISOString()) as AggregateRow[];

  // ── Weekly aggregate (per channel) ──
  // SQLite: strftime("%Y-%W", ...) is "year-week_of_year_monday_based" but
  // less portable. Easier: bucket client-side by computing the ISO week start
  // from placed_at. We pull rows in the window and aggregate in JS.
  const weeklyRaw = sqlite
    .prepare(
      `SELECT placed_at, channel, total
       FROM orders
       WHERE placed_at IS NOT NULL
         AND placed_at >= ?
         AND (status IS NULL OR status != 'cancelled')`,
    )
    .all(weeklyWindowStart.toISOString()) as Array<{ placed_at: string; channel: string; total: number }>;

  const channels = Array.from(new Set(monthlyRows.map((r) => r.channel))).sort();

  // Build zero-filled monthly buckets
  const monthlyBuckets: Bucket[] = months.map((m) => ({
    key: monthKey(m),
    label: monthLabel(m),
    revenue: 0,
    orders: 0,
    byChannel: Object.fromEntries(channels.map((c) => [c, 0])),
  }));
  const monthIndex = new Map(monthlyBuckets.map((b, i) => [b.key, i]));
  for (const row of monthlyRows) {
    const idx = monthIndex.get(row.bucket);
    if (idx === undefined) continue;
    monthlyBuckets[idx].revenue += row.revenue || 0;
    monthlyBuckets[idx].orders += row.orders || 0;
    monthlyBuckets[idx].byChannel[row.channel] = (monthlyBuckets[idx].byChannel[row.channel] || 0) + (row.revenue || 0);
  }

  // Build zero-filled weekly buckets
  const weeklyBuckets: Bucket[] = weeks.map((w) => ({
    key: isoDate(w),
    label: weekLabel(w),
    revenue: 0,
    orders: 0,
    byChannel: Object.fromEntries(channels.map((c) => [c, 0])),
  }));
  const weekIndex = new Map(weeklyBuckets.map((b, i) => [b.key, i]));
  for (const r of weeklyRaw) {
    const placedDate = new Date(r.placed_at);
    if (Number.isNaN(placedDate.getTime())) continue;
    const wStart = startOfIsoWeekUtc(placedDate);
    const idx = weekIndex.get(isoDate(wStart));
    if (idx === undefined) continue;
    weeklyBuckets[idx].revenue += r.total || 0;
    weeklyBuckets[idx].orders += 1;
    weeklyBuckets[idx].byChannel[r.channel] = (weeklyBuckets[idx].byChannel[r.channel] || 0) + (r.total || 0);
  }

  // ── MoM cards: this month vs previous calendar month ──
  const thisMonth = monthlyBuckets[monthlyBuckets.length - 1];
  const lastMonth = monthlyBuckets[monthlyBuckets.length - 2] ?? {
    revenue: 0, orders: 0, byChannel: {}, key: "", label: "",
  };
  const aovThis = thisMonth.orders > 0 ? thisMonth.revenue / thisMonth.orders : 0;
  const aovLast = lastMonth.orders > 0 ? lastMonth.revenue / lastMonth.orders : 0;
  const pctDelta = (a: number, b: number) => (b === 0 ? null : (a - b) / b);

  const mom = {
    thisMonth: {
      label: thisMonth.label,
      revenue: thisMonth.revenue,
      orders: thisMonth.orders,
      aov: aovThis,
    },
    lastMonth: {
      label: lastMonth.label,
      revenue: lastMonth.revenue,
      orders: lastMonth.orders,
      aov: aovLast,
    },
    delta: {
      revenue: pctDelta(thisMonth.revenue, lastMonth.revenue),
      orders: pctDelta(thisMonth.orders, lastMonth.orders),
      aov: pctDelta(aovThis, aovLast),
    },
  };

  return NextResponse.json({
    channels,
    monthly: monthlyBuckets,
    weekly: weeklyBuckets,
    mom,
  });
}
