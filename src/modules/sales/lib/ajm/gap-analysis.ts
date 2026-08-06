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

const READERS = READER_CATEGORIES.map((c) => `'${c}'`).join(",");
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface BrandWindow {
  label: string;
  start: string;
  end: string;
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
  gap: {
    revenue: number;
    /** Reader revenue AJM earned in its window — a category Jaxy could not sell. */
    categoryReaders: number;
    categoryReadersNote: string;
    /** Gap attributable to having fewer active customers, at Jaxy's own revenue/customer. */
    fewerCustomers: number;
    customerCountDelta: number;
    /** Gap from lower order frequency among the customers we do have. */
    lowerFrequency: number;
    /** Gap from a smaller average basket. */
    lowerAov: number;
    unexplained: number;
  };
  byChannel: Array<{ channel: string; ajmRevenue: number; jaxyRevenue: number; delta: number }>;
  /** Customers AJM had that Jaxy has never sold to, sized by AJM spend. */
  lostCustomers: { count: number; ajmRevenue: number; topAccounts: Array<{ name: string; companyId: string | null; accountId: string | null; ajmRevenue: number; lastOrder: string | null; readerShare: number }> };
}

function ajmWindow(start: string, end: string, label: string): BrandWindow {
  const row = sqlite.prepare(`
    SELECT ROUND(SUM(total),2) AS revenue, COUNT(*) AS orders,
           COUNT(DISTINCT COALESCE(company_id, customer_name)) AS customers
    FROM ajm_orders
    WHERE cancelled = 0 AND order_date >= ? AND order_date <= ?
  `).get(start, end) as { revenue: number | null; orders: number; customers: number };
  const revenue = row.revenue ?? 0;
  return {
    label, start, end, revenue, orders: row.orders, customers: row.customers,
    aov: row.orders ? r2(revenue / row.orders) : 0,
    ordersPerCustomer: row.customers ? r2(row.orders / row.customers) : 0,
    revenuePerCustomer: row.customers ? r2(revenue / row.customers) : 0,
  };
}

function jaxyWindow(start: string, end: string, label: string): BrandWindow {
  const row = sqlite.prepare(`
    SELECT ROUND(SUM(total),2) AS revenue, COUNT(*) AS orders,
           COUNT(DISTINCT COALESCE(company_id, id)) AS customers
    FROM orders
    WHERE status NOT IN ('cancelled','returned') AND placed_at >= ? AND placed_at <= ?
  `).get(start, end + "T23:59:59") as { revenue: number | null; orders: number; customers: number };
  const revenue = row.revenue ?? 0;
  return {
    label, start, end, revenue, orders: row.orders, customers: row.customers,
    aov: row.orders ? r2(revenue / row.orders) : 0,
    ordersPerCustomer: row.customers ? r2(row.orders / row.customers) : 0,
    revenuePerCustomer: row.customers ? r2(revenue / row.customers) : 0,
  };
}

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

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
  const readerRow = sqlite.prepare(`
    SELECT ROUND(SUM(i.line_total),2) AS rev
    FROM ajm_orders o JOIN ajm_order_items i ON i.order_id = o.id
    WHERE o.cancelled = 0 AND o.order_date >= ? AND o.order_date <= ? AND i.category IN (${READERS})
  `).get(ajm.start, ajm.end) as { rev: number | null };
  const categoryReaders = readerRow.rev ?? 0;

  // Decompose the remaining gap. Each term is computed holding the others at
  // Jaxy's actual rates, so they sum without double-counting.
  const revenueGap = r2(ajm.revenue - jaxy.revenue);
  const customerDelta = ajm.customers - jaxy.customers;
  const fewerCustomers = r2(Math.max(0, customerDelta) * jaxy.revenuePerCustomer);
  const freqDelta = Math.max(0, ajm.ordersPerCustomer - jaxy.ordersPerCustomer);
  const lowerFrequency = r2(freqDelta * jaxy.customers * jaxy.aov);
  const aovDelta = Math.max(0, ajm.aov - jaxy.aov);
  const lowerAov = r2(aovDelta * ajm.orders);

  const byChannel = (() => {
    const a = sqlite.prepare(`
      SELECT CASE WHEN source='faire' THEN 'faire' WHEN source='shopify_retail' THEN 'retail' ELSE 'wholesale' END AS ch,
             ROUND(SUM(total),2) AS rev
      FROM ajm_orders WHERE cancelled=0 AND order_date >= ? AND order_date <= ? GROUP BY ch
    `).all(ajm.start, ajm.end) as Array<{ ch: string; rev: number }>;
    const j = sqlite.prepare(`
      SELECT CASE WHEN channel='faire' THEN 'faire' WHEN channel='shopify_dtc' THEN 'retail'
                  WHEN channel='amazon' THEN 'amazon' ELSE 'wholesale' END AS ch,
             ROUND(SUM(total),2) AS rev
      FROM orders WHERE status NOT IN ('cancelled','returned') AND placed_at >= ? AND placed_at <= ? GROUP BY ch
    `).all(jaxy.start, jaxy.end + "T23:59:59") as Array<{ ch: string; rev: number }>;
    const chans = [...new Set([...a.map((x) => x.ch), ...j.map((x) => x.ch)])];
    return chans.map((c) => {
      const ar = a.find((x) => x.ch === c)?.rev ?? 0;
      const jr = j.find((x) => x.ch === c)?.rev ?? 0;
      return { channel: c, ajmRevenue: ar, jaxyRevenue: jr, delta: r2(ar - jr) };
    }).sort((x, y) => y.delta - x.delta);
  })();

  // AJM customers (matched to a Frame company) that Jaxy has never sold to.
  const lost = sqlite.prepare(`
    SELECT o.company_id AS companyId, MAX(c.name) AS name, MAX(ca.id) AS accountId,
           ROUND(SUM(o.total),2) AS ajmRevenue, MAX(o.order_date) AS lastOrder,
           ROUND(SUM(CASE WHEN i.category IN (${READERS}) THEN i.line_total ELSE 0 END) * 100.0
                 / NULLIF(SUM(i.line_total),0), 1) AS readerShare
    FROM ajm_orders o
    JOIN ajm_order_items i ON i.order_id = o.id
    JOIN companies c ON c.id = o.company_id
    LEFT JOIN customer_accounts ca ON ca.company_id = o.company_id
    WHERE o.cancelled = 0 AND o.company_id IS NOT NULL
    GROUP BY o.company_id
    HAVING COALESCE(MAX(ca.lifetime_value), 0) = 0
    ORDER BY ajmRevenue DESC
  `).all() as Array<{ companyId: string; name: string; accountId: string | null; ajmRevenue: number; lastOrder: string | null; readerShare: number | null }>;

  return {
    dataSpans: { ajm: aSpan, jaxy: jSpan },
    overlap: { exists: overlapExists, start: overlapExists ? oStart : null, end: overlapExists ? oEnd : null, days },
    comparisonBasis: basis,
    ajm, jaxy,
    gap: {
      revenue: revenueGap,
      categoryReaders,
      categoryReadersNote: "Reader revenue AJM earned in this window. Jaxy sold no readers until the Aug 2026 launch, so this portion of the gap was structurally unavailable to us.",
      fewerCustomers,
      customerCountDelta: customerDelta,
      lowerFrequency,
      lowerAov,
      unexplained: r2(revenueGap - categoryReaders - fewerCustomers - lowerFrequency - lowerAov),
    },
    byChannel,
    lostCustomers: {
      count: lost.length,
      ajmRevenue: r2(lost.reduce((s, x) => s + x.ajmRevenue, 0)),
      topAccounts: lost.slice(0, 25).map((x) => ({
        name: x.name, companyId: x.companyId, accountId: x.accountId,
        ajmRevenue: x.ajmRevenue, lastOrder: x.lastOrder, readerShare: x.readerShare ?? 0,
      })),
    },
  };
}
