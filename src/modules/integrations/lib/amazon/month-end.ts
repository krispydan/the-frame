/**
 * Amazon month-end checklist.
 *
 * A set of checks that each answer one question a human would otherwise have
 * to remember to ask. Every check returns a status and, when something is
 * wrong, enough detail to act on without going digging.
 *
 * The checks are ordered by how expensive the mistake is to discover late:
 * unposted settlements and uncosted units distort the P&L for the month;
 * unmapped SKUs and unclassified fees quietly misstate accounts; the
 * inventory reconciliation catches a whole class of costing error that
 * nothing else would surface.
 */

import { sqlite } from "@/lib/db";

export type CheckStatus = "ok" | "attention" | "blocked";

export interface MonthEndCheck {
  id: string;
  title: string;
  status: CheckStatus;
  /** One-line summary of what was found. */
  summary: string;
  /** What to do about it, when there is something to do. */
  action?: string;
  /** Supporting rows, capped for display. */
  detail?: Array<Record<string, string | number | null>>;
}

export interface MonthEndReport {
  month: string;
  periodStart: string;
  periodEnd: string;
  checks: MonthEndCheck[];
  /** Worst status across all checks. */
  overall: CheckStatus;
}

const worst = (a: CheckStatus, b: CheckStatus): CheckStatus =>
  a === "blocked" || b === "blocked" ? "blocked"
    : a === "attention" || b === "attention" ? "attention"
      : "ok";

function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01`;
  const endDate = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of this
  return { start, end: endDate.toISOString().slice(0, 10) };
}

/**
 * Build the month-end checklist for a given month (YYYY-MM).
 */
export function buildAmazonMonthEnd(month: string): MonthEndReport {
  const { start, end } = monthBounds(month);
  const checks: MonthEndCheck[] = [];

  // ── 1. Settlements not yet posted to Xero ──
  const unposted = sqlite.prepare(`
    SELECT REPLACE(external_id, 'amazon_settlement_', '') AS settlementId,
           period_start AS periodStart, period_end AS periodEnd, net_amount AS net
    FROM settlements
    WHERE channel = 'amazon' AND xero_transaction_id IS NULL
      AND IFNULL(period_end, period_start) BETWEEN ? AND ?
    ORDER BY period_end
  `).all(start, end) as Array<Record<string, string | number | null>>;

  checks.push(unposted.length === 0
    ? { id: "settlements_posted", title: "Settlements posted to Xero", status: "ok", summary: "All settlements in this period are posted." }
    : {
      id: "settlements_posted", title: "Settlements posted to Xero", status: "blocked",
      summary: `${unposted.length} settlement(s) closed in this period have not been posted to Xero.`,
      action: "Post them before closing the month, or the period's fees and revenue will be missing from the P&L.",
      detail: unposted,
    });

  // ── 2. Uncosted units (COGS coverage) ──
  const coverage = sqlite.prepare(`
    SELECT
      IFNULL((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
              WHERE o.channel='amazon' AND o.status IN ('shipped','delivered')
                AND date(o.shipped_at) BETWEEN ? AND ?), 0) AS shippedUnits,
      IFNULL((SELECT SUM(d.quantity) FROM inventory_cost_depletions d
              WHERE d.channel='amazon' AND date(d.depleted_at) BETWEEN ? AND ?), 0) AS costedUnits
  `).get(start, end, start, end) as { shippedUnits: number; costedUnits: number };

  const uncosted = coverage.shippedUnits - coverage.costedUnits;
  checks.push(uncosted <= 0
    ? { id: "cogs_coverage", title: "COGS coverage", status: "ok", summary: `All ${coverage.shippedUnits} shipped units are costed.` }
    : {
      id: "cogs_coverage", title: "COGS coverage", status: "blocked",
      summary: `${uncosted} of ${coverage.shippedUnits} shipped units have no cost attached.`,
      action: "Run the daily COGS backfill for this period. Until then gross margin is overstated.",
    });

  // ── 3. Open COGS exceptions ──
  const exceptions = sqlite.prepare(`
    SELECT type, COUNT(*) AS count, SUM(units) AS units
    FROM cogs_exceptions
    WHERE channel = 'amazon' AND status = 'open'
    GROUP BY type ORDER BY count DESC
  `).all() as Array<Record<string, string | number | null>>;

  checks.push(exceptions.length === 0
    ? { id: "cogs_exceptions", title: "COGS exceptions", status: "ok", summary: "No open exceptions." }
    : {
      id: "cogs_exceptions", title: "COGS exceptions", status: "attention",
      summary: `${exceptions.reduce((s, e) => s + Number(e.count ?? 0), 0)} open exception(s).`,
      action: "Resolve under Finance → COGS, then re-cost the affected days.",
      detail: exceptions,
    });

  // ── 4. Unmapped SKUs ──
  const unmapped = sqlite.prepare(`
    SELECT oi.sku AS sku, SUM(oi.quantity) AS units
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.channel='amazon' AND oi.sku_id IS NULL
      AND date(o.placed_at) BETWEEN ? AND ?
    GROUP BY oi.sku ORDER BY units DESC
  `).all(start, end) as Array<Record<string, string | number | null>>;

  checks.push(unmapped.length === 0
    ? { id: "unmapped_skus", title: "SKU mapping", status: "ok", summary: "Every Amazon SKU resolves to the catalog." }
    : {
      id: "unmapped_skus", title: "SKU mapping", status: "blocked",
      summary: `${unmapped.length} Amazon SKU(s) do not resolve to a catalog SKU.`,
      action: "Add catalog_sku_aliases rows (scripts/amazon-seed-fba-aliases.ts reports the candidates), then re-import and re-cost.",
      detail: unmapped,
    });

  // ── 5. Unclassified settlement lines ──
  const unclassified = sqlite.prepare(`
    SELECT s.external_id AS settlement, sli.description AS description, sli.amount AS amount
    FROM settlement_line_items sli JOIN settlements s ON s.id = sli.settlement_id
    WHERE s.channel='amazon' AND sli.description LIKE 'Unclassified%'
      AND IFNULL(s.period_end, s.period_start) BETWEEN ? AND ?
  `).all(start, end) as Array<Record<string, string | number | null>>;

  checks.push(unclassified.length === 0
    ? { id: "unclassified_fees", title: "Fee classification", status: "ok", summary: "Every settlement line was recognised." }
    : {
      id: "unclassified_fees", title: "Fee classification", status: "attention",
      summary: `${unclassified.length} settlement line(s) landed in the suspense account.`,
      action: "Add the mapping in settlement-classify.ts and re-bridge, so the amount books to the right account.",
      detail: unclassified,
    });

  // ── 6. Inventory reconciliation: FIFO vs ShipHero + FBA ──
  //
  // The one check nothing else would surface. FIFO cost layers represent
  // units we OWN, wherever they physically sit. If that stops matching
  // ShipHero on-hand plus Amazon's stock, either a depletion was missed
  // (overstating inventory, understating COGS) or something was depleted
  // twice — exactly the failure mode the FBA transfer question is about.
  const fifoRemaining = (sqlite.prepare(
    "SELECT IFNULL(SUM(remaining_quantity), 0) AS n FROM inventory_cost_layers",
  ).get() as { n: number }).n;

  const warehouse = (sqlite.prepare(
    "SELECT IFNULL(SUM(quantity), 0) AS n FROM inventory WHERE location = 'warehouse'",
  ).get() as { n: number }).n;

  const fba = (sqlite.prepare(`
    WITH latest AS (SELECT sku, MAX(snapshot_date) AS d FROM amazon_fba_inventory GROUP BY sku)
    SELECT IFNULL(SUM(f.total_qty), 0) AS n
    FROM amazon_fba_inventory f JOIN latest ON latest.sku = f.sku AND latest.d = f.snapshot_date
  `).get() as { n: number }).n;

  const physical = warehouse + fba;
  const drift = fifoRemaining - physical;
  // Tolerance scales with holding size: small absolute gaps are normal
  // (timing between snapshots, in-transit units), a large one is not.
  const tolerance = Math.max(25, Math.round(physical * 0.05));

  checks.push(Math.abs(drift) <= tolerance
    ? {
      id: "inventory_reconciliation", title: "Inventory reconciliation (FIFO vs ShipHero + FBA)", status: "ok",
      summary: `FIFO holds ${fifoRemaining} units against ${physical} physical (${warehouse} ShipHero + ${fba} FBA). Drift ${drift} is within tolerance.`,
    }
    : {
      id: "inventory_reconciliation", title: "Inventory reconciliation (FIFO vs ShipHero + FBA)", status: "attention",
      summary: `FIFO holds ${fifoRemaining} units but physical stock is ${physical} (${warehouse} ShipHero + ${fba} FBA) — drift of ${drift}, tolerance ${tolerance}.`,
      action: drift > 0
        ? "FIFO shows more than exists: a sale may not have been costed, which overstates inventory and understates COGS."
        : "FIFO shows less than exists: units may have been depleted twice — check for an inventory transfer that was costed as a sale.",
    });

  // ── 7. FBA reimbursements — income that is easy to miss ──
  const settlementsCount = (sqlite.prepare(
    "SELECT COUNT(*) AS n FROM settlements WHERE channel='amazon' AND IFNULL(period_end, period_start) BETWEEN ? AND ?",
  ).get(start, end) as { n: number }).n;

  checks.push({
    id: "reimbursements", title: "FBA reimbursements",
    status: settlementsCount === 0 ? "attention" : "ok",
    summary: settlementsCount === 0
      ? "No settlements bridged for this period — reimbursements cannot be confirmed."
      : "Reimbursements arrive inside settlements and are included in the figures above.",
    action: settlementsCount === 0
      ? "Run the settlement sync for this period before closing."
      : "Amazon pays for inventory it loses or damages. This is real income that never appears as a sale — worth a glance in Seller Central if the period looks light.",
  });

  return {
    month, periodStart: start, periodEnd: end, checks,
    overall: checks.reduce<CheckStatus>((acc, c) => worst(acc, c.status), "ok"),
  };
}
