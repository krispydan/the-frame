/**
 * AJM vs Jaxy gap decomposition — "why are our sales lower?"
 *
 * Splits the revenue difference into causes that can actually be acted on:
 *   1. category    readers AJM sold and Jaxy doesn't stock (until Aug 2026)
 *   2. customers   fewer active buying accounts
 *   3. frequency   the accounts we do have order less often
 *   4. basket      smaller average order value
 *
 * ── The comparability trap ───────────────────────────────────────────────
 * AJM's exports end 2025-12-01; Jaxy is trading in 2026. A naive "AJM 2024 vs
 * Jaxy 2026" chart compares different years of different businesses and reads
 * as a much bigger gap than reality. So every comparison here is explicit
 * about its basis, and `overlap` reports whether the two datasets actually
 * share calendar time. When they don't, the honest comparison is
 * like-for-like TRAILING 12 MONTHS (each brand's own last 12 months of data),
 * which is what `trailing12` provides — clearly labelled as a
 * different-era comparison, not a same-period one.
 */
import { sqlite } from "@/lib/db";
import { READER_CATEGORIES } from "./categorize";
import { AJM_CHANNEL_SQL, JAXY_CHANNEL_SQL } from "./channels";

const READERS = READER_CATEGORIES.map((c) => `'${c}'`).join(",");
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface BrandWindow {
  label: string;
  start: string;
  end: string;
  /** First/last date with actual data inside the window (may be narrower). */
  dataStart?: string | null;
  dataEnd?: string | null;
  revenue: number;
  orders: number;
  customers: number;
  aov: number;
  ordersPerCustomer: number;
  revenuePerCustomer: number;
}

export interface GapAnalysis {
  dataSpans: { ajm: { start: string; end: string }; jaxy: { start: string; end: string } };
  overlap: { exists: boolean; start: string | null; end: string | null; days: number };
  comparisonBasis: string;
  ajm: BrandWindow;
  jaxy: BrandWindow;
  monthlyRates: {
    ajmMonths: number; jaxyMonths: number;
    ajmRevenuePerMonth: number; jaxyRevenuePerMonth: number;
    gapPerMonth: number; note: string;
  };
  gap: {
    revenue: number;
    revenueNote: string;
    /** Reader revenue AJM earned in its window — a category Jaxy could not sell. */
    categoryReaders: number;
    categoryReadersNote: string;
    customerCountDelta: number;
    decomposition: {
      basis: string;
      customerEffect: number;
      frequencyEffect: number;
      aovEffect: number;
      residual: number;
      residualNote: string;
    };
  };
  byChannel: Array<{ channel: string; ajmRevenue: number; jaxyRevenue: number; delta: number }>;
  /** Customers AJM had that Jaxy has never sold to, sized by AJM spend. */
  lostCustomers: { count: number; ajmRevenue: number; topAccounts: Array<{ name: string; companyId: string | null; accountId: string | null; ajmRevenue: number; ajmOrders: number; lastOrder: string | null; readerShare: number }> };
}

function ajmWindow(start: string, end: string, label: string): BrandWindow {
  const row = sqlite.prepare(`
    SELECT ROUND(SUM(total),2) AS revenue, COUNT(*) AS orders,
           COUNT(DISTINCT COALESCE(company_id, customer_name)) AS customers,
           MIN(order_date) AS firstSeen, MAX(order_date) AS lastSeen
    FROM ajm_orders
    WHERE cancelled = 0 AND order_date >= ? AND order_date <= ?
  `).get(start, end) as { revenue: number | null; orders: number; customers: number; firstSeen: string | null; lastSeen: string | null };
  const revenue = row.revenue ?? 0;
  return {
    label, start, end, revenue, orders: row.orders, customers: row.customers,
    dataStart: row.firstSeen, dataEnd: row.lastSeen,
    aov: row.orders ? r2(revenue / row.orders) : 0,
    ordersPerCustomer: row.customers ? r2(row.orders / row.customers) : 0,
    revenuePerCustomer: row.customers ? r2(revenue / row.customers) : 0,
  };
}

function jaxyWindow(start: string, end: string, label: string): BrandWindow {
  const row = sqlite.prepare(`
    SELECT ROUND(SUM(total),2) AS revenue, COUNT(*) AS orders,
           COUNT(DISTINCT COALESCE(company_id, id)) AS customers,
           MIN(substr(placed_at,1,10)) AS firstSeen, MAX(substr(placed_at,1,10)) AS lastSeen
    FROM orders
    WHERE status NOT IN ('cancelled','returned') AND placed_at >= ? AND placed_at <= ?
  `).get(start, end + "T23:59:59") as { revenue: number | null; orders: number; customers: number; firstSeen: string | null; lastSeen: string | null };
  const revenue = row.revenue ?? 0;
  return {
    label, start, end, revenue, orders: row.orders, customers: row.customers,
    // Actual data extent inside the window — the divisor for monthly rates.
    // Dividing by the requested window instead understated Jaxy's run-rate
    // ~3.4x, because The Frame holds only ~3.5 months of orders.
    dataStart: row.firstSeen, dataEnd: row.lastSeen,
    aov: row.orders ? r2(revenue / row.orders) : 0,
    ordersPerCustomer: row.customers ? r2(row.orders / row.customers) : 0,
    revenuePerCustomer: row.customers ? r2(revenue / row.customers) : 0,
  };
}

/** Months actually covered by data in a window (never the nominal window). */
function activeMonths(w: BrandWindow): number {
  const s = w.dataStart ?? w.start, e = w.dataEnd ?? w.end;
  const days = (Date.parse(`${e}T00:00:00Z`) - Date.parse(`${s}T00:00:00Z`)) / 86_400_000;
  return Math.max(0.5, days / 30.44);
}

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Like-for-like on BUSINESS AGE: each brand's first N months of trading.
 *
 * Jaxy began selling 2026-04-21 (confirmed by Daniel, Aug 2026), so comparing
 * its first months to a mature AJM's trailing year measures company age, not
 * execution. This puts both at the same point in their life.
 *
 * CAVEAT, and it matters: AJM's data starts 2019-10-31, which is where their
 * Shopify export begins — NOT necessarily when AJ Morgan began trading. AJM
 * was an established brand, so its "first months" here may already include an
 * existing customer base carried over from earlier channels. Treat AJM's
 * early-window figures as an upper bound on a true standing start.
 */
export function compareByAge(months = 3.5) {
  const aStart = (sqlite.prepare(
    "SELECT MIN(order_date) AS s FROM ajm_orders WHERE cancelled = 0 AND order_date IS NOT NULL",
  ).get() as { s: string }).s;
  const jStart = (sqlite.prepare(
    "SELECT MIN(substr(placed_at,1,10)) AS s FROM orders WHERE status NOT IN ('cancelled','returned') AND placed_at IS NOT NULL",
  ).get() as { s: string }).s;
  const days = Math.round(months * 30.44);
  const ajm = ajmWindow(aStart, addDays(aStart, days), `AJM first ${months}m (${aStart} →)`);
  const jaxy = jaxyWindow(jStart, addDays(jStart, days), `Jaxy first ${months}m (${jStart} →)`);
  return {
    months,
    ajm,
    jaxy,
    ratios: {
      revenue: ajm.revenue > 0 ? r2((jaxy.revenue / ajm.revenue) * 100) : null,
      customers: ajm.customers > 0 ? r2((jaxy.customers / ajm.customers) * 100) : null,
      aov: ajm.aov > 0 ? r2((jaxy.aov / ajm.aov) * 100) : null,
    },
    caveat: "AJM's window starts where its Shopify export begins (2019-10-31), which may not be when AJ Morgan started trading — as an established brand it likely carried an existing customer base in. Jaxy's start (2026-04-21) is a true standing start. So AJM's figures here flatter AJM.",
  };
}

export function analyzeGap(opts?: { mode?: "overlap" | "trailing12" }): GapAnalysis {
  const aSpan = sqlite.prepare(
    "SELECT MIN(order_date) AS start, MAX(order_date) AS end FROM ajm_orders WHERE cancelled = 0 AND order_date IS NOT NULL",
  ).get() as { start: string; end: string };
  const jSpan = sqlite.prepare(
    "SELECT MIN(substr(placed_at,1,10)) AS start, MAX(substr(placed_at,1,10)) AS end FROM orders WHERE status NOT IN ('cancelled','returned') AND placed_at IS NOT NULL",
  ).get() as { start: string; end: string };

  const oStart = aSpan.start > jSpan.start ? aSpan.start : jSpan.start;
  const oEnd = aSpan.end < jSpan.end ? aSpan.end : jSpan.end;
  const overlapExists = !!(oStart && oEnd && oStart <= oEnd);
  const days = overlapExists
    ? Math.round((Date.parse(`${oEnd}T00:00:00Z`) - Date.parse(`${oStart}T00:00:00Z`)) / 86_400_000)
    : 0;

  // Prefer a genuine same-calendar-time comparison; fall back to each brand's
  // own trailing 12 months when the datasets don't overlap meaningfully.
  const useOverlap = (opts?.mode ?? (overlapExists && days >= 90 ? "overlap" : "trailing12")) === "overlap" && overlapExists;

  let ajm: BrandWindow, jaxy: BrandWindow, basis: string;
  if (useOverlap) {
    ajm = ajmWindow(oStart, oEnd, `AJM ${oStart} → ${oEnd}`);
    jaxy = jaxyWindow(oStart, oEnd, `Jaxy ${oStart} → ${oEnd}`);
    basis = `Same calendar window — the ${days} days both datasets cover (${oStart} → ${oEnd}). Like-for-like.`;
  } else {
    const aS = addDays(aSpan.end, -365), jS = addDays(jSpan.end, -365);
    ajm = ajmWindow(aS, aSpan.end, `AJM trailing 12m (${aS} → ${aSpan.end})`);
    jaxy = jaxyWindow(jS, jSpan.end, `Jaxy trailing 12m (${jS} → ${jSpan.end})`);
    basis = `DIFFERENT ERAS — the datasets barely overlap (${days} days), so this compares each brand's own last 12 months: AJM ${aS}→${aSpan.end} vs Jaxy ${jS}→${jSpan.end}. Market conditions differ; treat as indicative, not controlled.`;
  }

  // Reader revenue in AJM's window — the category Jaxy could not sell.
  // Summed at LINE level (line_total), never SUM(order.total) across a join to
  // items, which would multiply each order's total by its line count.
  const readerRow = sqlite.prepare(`
    SELECT ROUND(SUM(i.line_total),2) AS rev
    FROM ajm_orders o JOIN ajm_order_items i ON i.order_id = o.id
    WHERE o.cancelled = 0 AND o.order_date >= ? AND o.order_date <= ? AND i.category IN (${READERS})
  `).get(ajm.start, ajm.end) as { rev: number | null };
  const categoryReaders = readerRow.rev ?? 0;

  // ── Decomposition ───────────────────────────────────────────────────────
  // Revenue = customers × orders-per-customer × AOV, so the gap decomposes by
  // sequential substitution — swapping one factor at a time from Jaxy's value
  // to AJM's. Unlike computing each term independently, these sum EXACTLY to
  // the gap (no negative "unexplained" residual).
  //
  // Both sides are normalized to a MONTHLY RATE first: the windows are
  // different lengths (AJM has years of history, The Frame holds only a few
  // months of Jaxy orders), and comparing raw totals across unequal windows
  // measures elapsed time, not performance.
  const ajmMonths = activeMonths(ajm);
  const jaxyMonths = activeMonths(jaxy);

  const aC = ajm.customers / ajmMonths, jC = jaxy.customers / jaxyMonths;   // active customers per month
  const aF = ajm.ordersPerCustomer, jF = jaxy.ordersPerCustomer;            // orders per customer
  const aV = ajm.aov, jV = jaxy.aov;                                        // average order value

  const ajmMonthly = r2(ajm.revenue / ajmMonths);
  const jaxyMonthly = r2(jaxy.revenue / jaxyMonths);
  const monthlyGap = r2(ajmMonthly - jaxyMonthly);

  const customerEffect = r2((aC - jC) * jF * jV);
  const frequencyEffect = r2(aC * (aF - jF) * jV);
  const aovEffect = r2(aC * aF * (aV - jV));
  const residual = r2(monthlyGap - customerEffect - frequencyEffect - aovEffect);

  const revenueGap = r2(ajm.revenue - jaxy.revenue);
  const customerDelta = ajm.customers - jaxy.customers;

  const byChannel = (() => {
    // Canonical model: wholesale = Shopify wholesale + Faire, both brands.
    const a = sqlite.prepare(`
      SELECT ${AJM_CHANNEL_SQL("o")} AS ch, ROUND(SUM(o.total),2) AS rev
      FROM ajm_orders o WHERE o.cancelled=0 AND o.order_date >= ? AND o.order_date <= ? GROUP BY ch
    `).all(ajm.start, ajm.end) as Array<{ ch: string; rev: number }>;
    const j = sqlite.prepare(`
      SELECT ${JAXY_CHANNEL_SQL("o")} AS ch, ROUND(SUM(o.total),2) AS rev
      FROM orders o WHERE o.status NOT IN ('cancelled','returned') AND o.placed_at >= ? AND o.placed_at <= ? GROUP BY ch
    `).all(jaxy.start, jaxy.end + "T23:59:59") as Array<{ ch: string; rev: number }>;
    const chans = [...new Set([...a.map((x) => x.ch), ...j.map((x) => x.ch)])];
    return chans.map((c) => {
      const ar = a.find((x) => x.ch === c)?.rev ?? 0;
      const jr = j.find((x) => x.ch === c)?.rev ?? 0;
      return { channel: c, ajmRevenue: ar, jaxyRevenue: jr, delta: r2(ar - jr) };
    }).sort((x, y) => y.delta - x.delta);
  })();

  // AJM customers (matched to a Frame company) that Jaxy has never sold to.
  //
  // Order totals and line-level category shares are aggregated in SEPARATE
  // CTEs before being joined. Doing it in one query — joining orders to items
  // and summing order.total — multiplies each order's total by its line count
  // (it inflated this list to $142M against a $9.6M dataset before the fix).
  const lost = sqlite.prepare(`
    WITH order_totals AS (
      SELECT company_id, ROUND(SUM(total),2) AS ajmRevenue,
             COUNT(*) AS ajmOrders, MAX(order_date) AS lastOrder
      FROM ajm_orders
      WHERE cancelled = 0 AND company_id IS NOT NULL
      GROUP BY company_id
    ),
    line_cats AS (
      SELECT o.company_id AS company_id,
             SUM(CASE WHEN i.category IN (${READERS}) THEN i.line_total ELSE 0 END) AS readerRev,
             SUM(i.line_total) AS lineRev
      FROM ajm_orders o JOIN ajm_order_items i ON i.order_id = o.id
      WHERE o.cancelled = 0 AND o.company_id IS NOT NULL
      GROUP BY o.company_id
    )
    SELECT t.company_id AS companyId, c.name AS name, ca.id AS accountId,
           t.ajmRevenue, t.ajmOrders, t.lastOrder,
           ROUND(COALESCE(lc.readerRev,0) * 100.0 / NULLIF(lc.lineRev,0), 1) AS readerShare
    FROM order_totals t
    JOIN companies c ON c.id = t.company_id
    LEFT JOIN customer_accounts ca ON ca.company_id = t.company_id
    LEFT JOIN line_cats lc ON lc.company_id = t.company_id
    WHERE COALESCE(ca.lifetime_value, 0) = 0
    ORDER BY t.ajmRevenue DESC
  `).all() as Array<{ companyId: string; name: string; accountId: string | null; ajmRevenue: number; ajmOrders: number; lastOrder: string | null; readerShare: number | null }>;

  return {
    dataSpans: { ajm: aSpan, jaxy: jSpan },
    overlap: { exists: overlapExists, start: overlapExists ? oStart : null, end: overlapExists ? oEnd : null, days },
    comparisonBasis: basis,
    ajm, jaxy,
    monthlyRates: {
      ajmMonths: r2(ajmMonths), jaxyMonths: r2(jaxyMonths),
      ajmRevenuePerMonth: ajmMonthly, jaxyRevenuePerMonth: jaxyMonthly,
      gapPerMonth: monthlyGap,
      note: "Windows differ in length, so all decomposition below uses monthly rates. Raw totals across unequal windows measure elapsed time, not performance.",
    },
    gap: {
      revenue: revenueGap,
      revenueNote: "Raw totals over unequal windows — NOT a like-for-like figure. Use monthlyRates for comparison.",
      categoryReaders,
      categoryReadersNote: "Reader revenue AJM earned in this window. Jaxy sold no readers until the Aug 2026 launch, so this portion of AJM's revenue was structurally unavailable to us. Shown as an overlay on the decomposition below, not an additional term — it is already inside the customer/frequency/AOV effects.",
      customerCountDelta: customerDelta,
      decomposition: {
        basis: "monthly rate; revenue = active customers/month × orders per customer × AOV; sequential substitution, terms sum exactly to gapPerMonth",
        customerEffect,
        frequencyEffect,
        aovEffect,
        residual,
        residualNote: "Rounding only; should be ~0.",
      },
    },
    byChannel,
    lostCustomers: {
      count: lost.length,
      ajmRevenue: r2(lost.reduce((s, x) => s + x.ajmRevenue, 0)),
      topAccounts: lost.slice(0, 25).map((x) => ({
        name: x.name, companyId: x.companyId, accountId: x.accountId,
        ajmRevenue: x.ajmRevenue, ajmOrders: x.ajmOrders,
        lastOrder: x.lastOrder, readerShare: x.readerShare ?? 0,
      })),
    },
  };
}
