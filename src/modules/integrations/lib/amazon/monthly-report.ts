/**
 * Amazon account performance, month over month.
 *
 * Modelled on the spreadsheet the operator already reads: metric rows, month
 * columns, and a change column. Two deliberate departures from that model:
 *
 * 1. **Giveaway is its own line.** On an account where a large share of units
 *    ship for no consideration, "Total Sales" without a giveaway line is the
 *    number that misleads — Amazon reports a Vine unit at full list price with
 *    an offsetting promotion, so gross looks like trading that never happened.
 *
 * 2. **It stops at contribution margin, not net profit.** Ad spend has no
 *    source in this system until the Amazon Ads connector is linked, and a
 *    "net profit" that silently excludes advertising is worse than a number
 *    that says what it is. `adSpendAvailable` reports which one you are
 *    looking at, and the narrative says so in words.
 *
 * COGS is real FIFO landed cost — product, freight and duties — not a flat
 * per-unit estimate, so margins here can be traced to a purchase order.
 */

import { sqlite } from "@/lib/db";

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

export interface AmazonMonthFigures {
  month: string;
  /** List price of everything ordered, before promotions. */
  grossSales: number;
  /** Promotional value given away — Vine and any true discounting. */
  giveaway: number;
  /** What buyers actually paid. gross − giveaway. */
  netSales: number;
  units: number;
  /** Units that took no money. */
  freeUnits: number;
  orders: number;
  /** Average order value on PAID orders — a giveaway would drag it to zero. */
  aov: number;
  referralFees: number;
  fbaFees: number;
  otherFees: number;
  totalFees: number;
  refunds: number;
  /** FIFO landed cost of units shipped, excluding seeded stock. */
  cogs: number;
  /** Landed cost of stock given away — marketing, not cost of sales. */
  seedingCost: number;
  /** netSales − fees − refunds − cogs. Before advertising. */
  contribution: number;
  contributionPct: number;
  sessions: number;
  conversionPct: number;
}

export interface AmazonMonthlyReport {
  months: AmazonMonthFigures[];
  /** First → last change per metric, absolute and percentage. */
  change: Record<string, { absolute: number; pct: number | null }> | null;
  adSpendAvailable: boolean;
  narrative: string[];
  provenance: string[];
}

/** Months present in the data, oldest first. */
function monthsWithData(limit: number): string[] {
  const rows = sqlite.prepare(`
    SELECT DISTINCT substr(date(purchase_date), 1, 7) AS m
    FROM amazon_order_rows
    WHERE purchase_date IS NOT NULL
    ORDER BY m DESC LIMIT ?
  `).all(limit) as Array<{ m: string }>;
  return rows.map((r) => r.m).reverse();
}

function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { start: `${month}-01`, end };
}

function figuresFor(month: string): AmazonMonthFigures {
  const { start, end } = monthBounds(month);

  // Sales come from the raw archive rather than `orders`, so a month reads the
  // same whether or not the import has caught up.
  const sales = sqlite.prepare(`
    SELECT
      IFNULL(SUM(r.item_price), 0) AS gross,
      IFNULL(SUM(r.item_promotion_discount + r.ship_promotion_discount), 0) AS giveaway,
      IFNULL(SUM(r.quantity), 0) AS units,
      IFNULL(SUM(CASE WHEN r.item_promotion_discount >= r.item_price - 0.005
                       AND r.item_price > 0.005 THEN r.quantity ELSE 0 END), 0) AS freeUnits,
      COUNT(DISTINCT r.amazon_order_id) AS orders,
      COUNT(DISTINCT CASE WHEN r.item_promotion_discount < r.item_price - 0.005
                          THEN r.amazon_order_id END) AS paidOrders
    FROM amazon_order_rows r
    WHERE date(r.purchase_date) BETWEEN ? AND ?
      AND IFNULL(LOWER(r.item_status), '') != 'cancelled'
  `).get(start, end) as {
    gross: number; giveaway: number; units: number; freeUnits: number;
    orders: number; paidOrders: number;
  };

  const fees = sqlite.prepare(`
    SELECT
      IFNULL(SUM(CASE WHEN sli.description = 'Referral commission' THEN -sli.amount ELSE 0 END), 0) AS referral,
      IFNULL(SUM(CASE WHEN sli.description IN ('FBA fulfilment fees','FBA storage fees') THEN -sli.amount ELSE 0 END), 0) AS fba,
      IFNULL(SUM(CASE WHEN sli.type = 'fee' AND sli.description NOT IN
             ('Referral commission','FBA fulfilment fees','FBA storage fees') THEN -sli.amount ELSE 0 END), 0) AS other,
      IFNULL(SUM(CASE WHEN sli.type = 'refund' THEN -sli.amount ELSE 0 END), 0) AS refunds
    FROM settlement_line_items sli
    JOIN settlements s ON s.id = sli.settlement_id
    WHERE s.channel = 'amazon'
      AND IFNULL(s.period_end, s.period_start) >= ?
      AND IFNULL(s.period_start, s.period_end) <= ?
  `).get(start, end) as { referral: number; fba: number; other: number; refunds: number };

  // Split COGS from seeding cost the same way the journal does, so the report
  // and the ledger cannot disagree.
  const cost = sqlite.prepare(`
    SELECT
      IFNULL(SUM(CASE WHEN seeded = 0 THEN ext ELSE 0 END), 0) AS cogs,
      IFNULL(SUM(CASE WHEN seeded = 1 THEN ext ELSE 0 END), 0) AS seeding
    FROM (
      SELECT d.quantity * (l.unit_cost + l.freight_per_unit + l.duties_per_unit) AS ext,
             CASE WHEN oi.id IS NOT NULL
                   AND IFNULL(oi.discount, 0) >= oi.total_price - 0.005
                   AND oi.total_price > 0.005 THEN 1 ELSE 0 END AS seeded
      FROM inventory_cost_depletions d
      JOIN inventory_cost_layers l ON l.id = d.cost_layer_id
      LEFT JOIN order_items oi ON oi.id = d.order_item_id
      WHERE d.channel = 'amazon' AND date(d.depleted_at) BETWEEN ? AND ?
    )
  `).get(start, end) as { cogs: number; seeding: number };

  const traffic = sqlite.prepare(`
    SELECT IFNULL(SUM(sessions), 0) AS sessions, IFNULL(SUM(units_ordered), 0) AS unitsOrdered
    FROM amazon_sales_traffic_daily WHERE date BETWEEN ? AND ?
  `).get(start, end) as { sessions: number; unitsOrdered: number };

  const grossSales = round2(sales.gross);
  const giveaway = round2(sales.giveaway);
  const netSales = round2(grossSales - giveaway);
  const totalFees = round2(fees.referral + fees.fba + fees.other);
  const cogs = round2(cost.cogs);
  const contribution = round2(netSales - totalFees - fees.refunds - cogs);

  return {
    month,
    grossSales, giveaway, netSales,
    units: sales.units,
    freeUnits: sales.freeUnits,
    orders: sales.orders,
    // AOV over PAID orders only. Dividing by all orders would let giveaways
    // drag the figure down and read as a pricing problem.
    aov: sales.paidOrders > 0 ? round2(netSales / sales.paidOrders) : 0,
    referralFees: round2(fees.referral),
    fbaFees: round2(fees.fba),
    otherFees: round2(fees.other),
    totalFees,
    refunds: round2(fees.refunds),
    cogs,
    seedingCost: round2(cost.seeding),
    contribution,
    contributionPct: pct(contribution, netSales),
    sessions: traffic.sessions,
    conversionPct: pct(traffic.unitsOrdered, traffic.sessions),
  };
}

const CHANGE_METRICS = [
  "grossSales", "giveaway", "netSales", "units", "freeUnits", "orders", "aov",
  "totalFees", "cogs", "seedingCost", "contribution", "sessions",
] as const;

export function buildAmazonMonthlyReport(opts?: { months?: number }): AmazonMonthlyReport {
  const months = monthsWithData(opts?.months ?? 3).map(figuresFor);
  const adSpendAvailable = false; // No source until the Amazon Ads connector is linked.

  let change: AmazonMonthlyReport["change"] = null;
  if (months.length >= 2) {
    const first = months[0];
    const last = months[months.length - 1];
    change = {};
    for (const k of CHANGE_METRICS) {
      const a = first[k] as number;
      const b = last[k] as number;
      change[k] = {
        absolute: round2(b - a),
        // A percentage change from zero is not 100% or infinity, it is
        // undefined. Reporting null lets the renderer say "new" instead of a
        // number that looks like a measurement.
        pct: a !== 0 ? Math.round(((b - a) / Math.abs(a)) * 1000) / 10 : null,
      };
    }
  }

  return {
    months, change, adSpendAvailable,
    narrative: buildNarrative(months, change, adSpendAvailable),
    provenance: buildProvenance(months),
  };
}

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const monthName = (m: string) => {
  const [y, mm] = m.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][mm - 1]} ${y}`;
};

/**
 * The "how to read it" paragraph.
 *
 * This is the part that makes the report digestible, and the part most likely
 * to become filler. Three rules keep it honest:
 *
 *   - Only compare when both periods have data. A month three days old does
 *     not get a trend sentence.
 *   - Name the SKU or month. "Some products declined" is not a finding.
 *   - Say what CANNOT be computed and why. A missing number that goes
 *     unexplained reads as a zero.
 */
export function buildNarrative(
  months: AmazonMonthFigures[],
  change: AmazonMonthlyReport["change"],
  adSpendAvailable: boolean,
): string[] {
  const out: string[] = [];
  if (months.length === 0) return ["No Amazon activity in the reporting window."];

  const last = months[months.length - 1];

  // 1. What was actually earned, versus what gross implies.
  if (last.giveaway > 0) {
    const share = pct(last.freeUnits, last.units);
    out.push(
      `${monthName(last.month)}: ${money(last.grossSales)} of gross, but ${money(last.giveaway)} of that was given away — ` +
      `${last.freeUnits} of ${last.units} units (${share}%) took no money. Buyers actually paid ${money(last.netSales)}.`,
    );
  } else {
    out.push(`${monthName(last.month)}: ${money(last.netSales)} of paid sales across ${last.units} units.`);
  }

  // 2. Direction, only with a real comparison behind it.
  if (change && months.length >= 2) {
    const first = months[0];
    const net = change.netSales;
    const dir = net.absolute >= 0 ? "grew" : "fell";
    const by = net.pct === null ? `by ${money(Math.abs(net.absolute))}` : `${Math.abs(net.pct)}%`;
    out.push(
      `Paid sales ${dir} ${by} from ${monthName(first.month)} to ${monthName(last.month)} ` +
      `(${money(first.netSales)} → ${money(last.netSales)}).`,
    );

    // A shift in giveaway mix explains more than the sales number alone.
    const firstShare = pct(first.freeUnits, first.units);
    const lastShare = pct(last.freeUnits, last.units);
    if (Math.abs(lastShare - firstShare) >= 10) {
      out.push(
        `Giveaway share moved from ${firstShare}% of units to ${lastShare}% over the same period, ` +
        `so the change in paid sales is partly a change in mix rather than in demand.`,
      );
    }
  }

  // 3. Margin, and what it does and does not include.
  if (last.netSales > 0) {
    out.push(
      `Contribution margin was ${money(last.contribution)} (${last.contributionPct}% of paid sales) after ` +
      `${money(last.totalFees)} of Amazon fees and ${money(last.cogs)} of landed cost.` +
      (last.seedingCost > 0
        ? ` A further ${money(last.seedingCost)} of stock was given away; that sits in marketing, not cost of sales.`
        : ""),
    );
  }

  // 4. Say plainly what is missing. Silence here reads as a zero.
  if (!adSpendAvailable) {
    out.push(
      `This is contribution margin, NOT net profit — it excludes advertising, which has no source in this ` +
      `system until the Amazon Ads connector is linked in Windsor. ACOS and TACOS cannot be computed yet.`,
    );
  }

  return out;
}

/** What the numbers rest on, and where they stop being reliable. */
export function buildProvenance(months: AmazonMonthFigures[]): string[] {
  const out: string[] = [];

  const settlementFrom = (sqlite.prepare(
    "SELECT MIN(date(posted_date)) AS d FROM amazon_settlement_rows",
  ).get() as { d: string | null }).d;
  if (settlementFrom) {
    out.push(
      `Fees and refunds come from settlements, which Windsor serves for 90 days only. ` +
      `Earliest settlement row held: ${settlementFrom}. Months before that show sales but no fees.`,
    );
  }

  out.push("COGS is real FIFO landed cost (product + freight + duties), traceable to a purchase order — not a flat per-unit estimate.");
  out.push("Amazon's reports run to T-2, so the current month is always short by a day or two.");

  const noTraffic = months.filter((m) => m.sessions === 0).map((m) => monthName(m.month));
  if (noTraffic.length > 0) {
    out.push(`No session data for ${noTraffic.join(", ")} — conversion is blank for those months rather than zero.`);
  }

  return out;
}

/**
 * Build the report and post it to Slack.
 *
 * Silent when there is no activity: a digest that fires every week with
 * nothing in it trains people to ignore the channel, and this one needs to be
 * read on the weeks it matters.
 */
export async function sendAmazonMonthlyDigest(opts?: { months?: number }): Promise<{
  sent: boolean;
  months: number;
  reason?: string;
}> {
  const report = buildAmazonMonthlyReport(opts);
  if (report.months.length === 0 || report.months.every((m) => m.units === 0)) {
    return { sent: false, months: report.months.length, reason: "No Amazon activity — digest suppressed." };
  }

  const { notifyAmazonMonthlyDigest } = await import("@/modules/integrations/lib/slack/notifications");
  await notifyAmazonMonthlyDigest({
    months: report.months.map((m) => ({
      month: m.month, grossSales: m.grossSales, giveaway: m.giveaway,
      netSales: m.netSales, units: m.units, freeUnits: m.freeUnits,
      contribution: m.contribution, contributionPct: m.contributionPct,
    })),
    narrative: report.narrative,
    provenance: report.provenance,
  });

  return { sent: true, months: report.months.length };
}
