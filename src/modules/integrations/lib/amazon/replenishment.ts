/**
 * FBA replenishment proposals.
 *
 * Amazon already tells us what it wants restocked, so this contains no demand
 * forecast. It applies the three corrections Amazon cannot make, because it
 * cannot see any of them:
 *
 * 1. **Our warehouse.** Amazon's recommended quantity is demand-side only. It
 *    does not know whether the units exist in ShipHero. A proposal we cannot
 *    physically ship is not a proposal, it is a purchasing signal — so the
 *    shortfall is reported rather than the number quietly reduced.
 *
 * 2. **Vine.** ⚠️ The single most important correction on this account.
 *    `units_sold_last_30_days` counts giveaways, which have run as high as 90%
 *    of units in a month. Replenishing to Amazon's number ships stock to FBA
 *    to meet demand that does not pay. Paid velocity is recomputed from our
 *    own order rows and BOTH are shown, because the gap is the point.
 *
 * 3. **Margin.** Amazon ranks by its own revenue. When warehouse stock is
 *    short, limited units should go to the SKUs that actually earn, so
 *    proposals are ranked by contribution per unit × paid velocity.
 *
 * Nothing here writes or sends. It produces a reviewable table; the transfer
 * order is a separate, explicitly confirmed step.
 */

import { sqlite } from "@/lib/db";
import { SKU_MAP_CTE, WAREHOUSE_CTE, COST_CTE, INTERNAL_SKU } from "./sku-map";

/** Cover target, in days, for FBA stock. Configurable per run. */
export const DEFAULT_COVER_DAYS = 60;

/** Velocity below this is too thin to extrapolate a cover target from. */
const MIN_VELOCITY_UNITS = 1;

export type ReplenishmentFlag =
  | "amazon_only_demand"
  | "warehouse_short"
  | "no_paid_velocity"
  | "no_cost_basis"
  | "overstocked";

export interface ReplenishmentLine {
  sku: string;
  asin: string | null;
  title: string | null;
  /** What Amazon asked for. */
  amazonRecommendedQty: number;
  amazonUnitsSold30d: number;
  amazonAlert: string | null;
  recommendedShipDate: string | null;
  daysOfSupply: number | null;
  /** FBA position today. */
  fbaAvailable: number;
  fbaInbound: number;
  /** Units we generated a transfer for that Amazon has not acknowledged yet.
   *  Counted as covered, or a second shipment goes out for stock on a truck. */
  inFlight: number;
  /** Units in OUR warehouse, resolved through the alias table. */
  warehouseAvailable: number;
  /** Units sold in the last 30 days that actually took money. */
  paidUnits30d: number;
  /** Units given away in the same window — the gap versus Amazon's figure. */
  seededUnits30d: number;
  /** Cover target applied to PAID velocity, net of stock already at or in
   *  transit to Amazon. */
  paidDemandQty: number;
  /** What we propose sending: paid demand, capped by warehouse stock. */
  proposedQty: number;
  /** Units we would send if the warehouse had them. */
  shortfall: number;
  /** Real FIFO landed cost per unit, where a layer exists. */
  landedCostPerUnit: number | null;
  price: number | null;
  /** price − landed cost. Null when either side is unknown. */
  contributionPerUnit: number | null;
  /** Ranking score: contribution × paid velocity. Null sorts last. */
  priorityScore: number | null;
  flags: ReplenishmentFlag[];
}

export interface ReplenishmentProposal {
  snapshotDate: string | null;
  coverDays: number;
  lines: ReplenishmentLine[];
  totals: {
    skusConsidered: number;
    skusProposed: number;
    proposedUnits: number;
    shortfallUnits: number;
    /** What Amazon would have had us send. */
    amazonRecommendedUnits: number;
    proposedCost: number;
  };
  warnings: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildReplenishmentProposal(opts?: {
  coverDays?: number;
  /** Evaluate against a fixed date — tests and reruns. */
  today?: string;
}): ReplenishmentProposal {
  const coverDays = opts?.coverDays ?? DEFAULT_COVER_DAYS;
  const today = opts?.today ?? new Date().toISOString().slice(0, 10);
  const windowStart = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86_400_000)
    .toISOString().slice(0, 10);

  const snapshotDate = (sqlite.prepare(
    "SELECT MAX(snapshot_date) AS d FROM amazon_restock_recommendations",
  ).get() as { d: string | null }).d;

  const warnings: string[] = [];
  if (!snapshotDate) {
    return {
      snapshotDate: null, coverDays, lines: [],
      totals: { skusConsidered: 0, skusProposed: 0, proposedUnits: 0, shortfallUnits: 0, amazonRecommendedUnits: 0, proposedCost: 0 },
      warnings: ["No restock recommendations held — run the restock sync before proposing a shipment."],
    };
  }

  // Stale snapshots are worse than none: Amazon's numbers move daily, and a
  // proposal built on a fortnight-old view would over-ship what has since
  // sold through.
  const ageDays = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${snapshotDate}T00:00:00Z`)) / 86_400_000,
  );
  if (ageDays > 3) {
    warnings.push(`Restock snapshot is ${ageDays} days old (${snapshotDate}). Re-run the restock sync for a current view.`);
  }

  const rows = sqlite.prepare(`
    ${SKU_MAP_CTE},
    ${WAREHOUSE_CTE},
    -- Paid vs seeded units over the trailing window, from OUR archive. This
    -- is the Vine correction: Amazon's units_sold_last_30_days counts both.
    -- Keyed on the INTERNAL spelling so a product listed both merchant and
    -- FBA has its demand summed rather than split across two lines.
    velocity AS (
      SELECT ${INTERNAL_SKU("r.sku")} AS sku,
             SUM(CASE WHEN r.item_promotion_discount >= r.item_price - 0.005
                       AND r.item_price > 0.005 THEN 0 ELSE r.quantity END) AS paidUnits,
             SUM(CASE WHEN r.item_promotion_discount >= r.item_price - 0.005
                       AND r.item_price > 0.005 THEN r.quantity ELSE 0 END) AS seededUnits
      FROM amazon_order_rows r
      WHERE date(r.purchase_date) BETWEEN ? AND ?
        AND IFNULL(LOWER(r.item_status), '') != 'cancelled'
      GROUP BY ${INTERNAL_SKU("r.sku")}
    ),
    -- Transfers we generated but Amazon has not acknowledged as inbound yet.
    -- Amazon can take days to show a shipment, and during that window its own
    -- inbound count reads zero — so without this the proposal keeps
    -- recommending units already on a truck, and a second shipment goes out.
    in_flight AS (
      SELECT ${INTERNAL_SKU("sku")} AS sku, SUM(quantity) AS qty
      FROM amazon_fba_transfers
      WHERE received_at IS NULL AND created_for >= ?
      GROUP BY ${INTERNAL_SKU("sku")}
    ),
    ${COST_CTE}
    -- One row per PRODUCT, not per listing. MAX on the FBA position because
    -- both listings report the same physical stock; SUM would double it.
    -- The -FBA spelling is preferred for display since that is what ships.
    SELECT
      MAX(rr.sku)               AS sku,
      MAX(rr.asin)              AS asin,
      MAX(rr.product_name)      AS amazonTitle,
      MAX(rr.alert)             AS amazonAlert,
      MAX(rr.recommended_qty)   AS amazonRecommendedQty,
      MAX(rr.recommended_ship_date) AS recommendedShipDate,
      MAX(rr.units_sold_30d)    AS amazonUnitsSold30d,
      MAX(rr.days_of_supply)    AS daysOfSupply,
      MAX(rr.available)         AS fbaAvailable,
      MAX(rr.inbound + rr.working + rr.receiving) AS fbaInbound,
      MAX(rr.price)             AS price,
      IFNULL(MAX(w.qty), 0)     AS warehouseAvailable,
      IFNULL(MAX(tf.qty), 0)    AS inFlight,
      IFNULL(MAX(v.paidUnits), 0)   AS paidUnits30d,
      IFNULL(MAX(v.seededUnits), 0) AS seededUnits30d,
      MAX(c.landed)             AS landedCostPerUnit
    FROM amazon_restock_recommendations rr
    LEFT JOIN sku_map m   ON m.spelling = rr.internal_sku
    LEFT JOIN warehouse w ON w.sku_id = m.sku_id
    LEFT JOIN cost c      ON c.sku_id = m.sku_id
    LEFT JOIN velocity v   ON v.sku = rr.internal_sku
    LEFT JOIN in_flight tf ON tf.sku = rr.internal_sku
    WHERE rr.snapshot_date = ?
    GROUP BY rr.internal_sku
  `).all(windowStart, today, windowStart, snapshotDate) as Array<{
    sku: string; asin: string | null; amazonTitle: string | null;
    amazonAlert: string | null; amazonRecommendedQty: number;
    recommendedShipDate: string | null; amazonUnitsSold30d: number;
    daysOfSupply: number | null; fbaAvailable: number; fbaInbound: number;
    price: number | null; warehouseAvailable: number; inFlight: number;
    paidUnits30d: number; seededUnits30d: number; landedCostPerUnit: number | null;
  }>;

  const titles = sqlite.prepare(`
    SELECT internal_sku AS sku, title FROM amazon_listings
    WHERE internal_sku IS NOT NULL AND title IS NOT NULL
  `).all() as Array<{ sku: string; title: string }>;
  const titleBySku = new Map(titles.map((t) => [t.sku, t.title]));

  const lines: ReplenishmentLine[] = rows.map((r) => {
    const flags: ReplenishmentFlag[] = [];

    // ── Correction 2: demand from PAID velocity, not Amazon's blended figure.
    const paidPerDay = r.paidUnits30d / 30;
    const covered = r.fbaAvailable + r.fbaInbound + r.inFlight;
    const rawDemand = Math.max(0, Math.ceil(paidPerDay * coverDays) - covered);

    if (r.paidUnits30d < MIN_VELOCITY_UNITS) {
      // No paid sales means no paid demand to cover, however loudly Amazon
      // asks. Sending here is a bet, and it should be a deliberate one.
      flags.push("no_paid_velocity");
    }
    if (r.amazonRecommendedQty > 0 && rawDemand === 0) {
      flags.push("amazon_only_demand");
    }
    if (covered > 0 && paidPerDay > 0 && covered / paidPerDay > coverDays * 2) {
      flags.push("overstocked");
    }

    const paidDemandQty = r.paidUnits30d >= MIN_VELOCITY_UNITS ? rawDemand : 0;

    // ── Correction 1: cap by what the warehouse actually holds.
    const proposedQty = Math.min(paidDemandQty, Math.max(0, r.warehouseAvailable));
    const shortfall = Math.max(0, paidDemandQty - proposedQty);
    if (shortfall > 0) flags.push("warehouse_short");

    // ── Correction 3: rank by what the units earn.
    const landed = r.landedCostPerUnit;
    if (landed === null && proposedQty > 0) flags.push("no_cost_basis");
    const contributionPerUnit =
      landed !== null && r.price !== null ? round2(r.price - landed) : null;
    const priorityScore =
      contributionPerUnit !== null ? round2(contributionPerUnit * paidPerDay) : null;

    return {
      sku: r.sku,
      asin: r.asin,
      title: titleBySku.get(r.sku.replace(/-FBA$/i, "")) ?? r.amazonTitle,
      amazonRecommendedQty: r.amazonRecommendedQty,
      amazonUnitsSold30d: r.amazonUnitsSold30d,
      amazonAlert: r.amazonAlert && r.amazonAlert.trim() !== "" ? r.amazonAlert : null,
      recommendedShipDate: r.recommendedShipDate,
      daysOfSupply: r.daysOfSupply,
      fbaAvailable: r.fbaAvailable,
      fbaInbound: r.fbaInbound,
      inFlight: r.inFlight,
      warehouseAvailable: r.warehouseAvailable,
      paidUnits30d: r.paidUnits30d,
      seededUnits30d: r.seededUnits30d,
      paidDemandQty,
      proposedQty,
      shortfall,
      landedCostPerUnit: landed !== null ? round2(landed) : null,
      price: r.price,
      contributionPerUnit,
      priorityScore,
      flags,
    };
  });

  // Highest earning first; unknown-contribution lines sort last rather than
  // as zero, so a missing cost basis does not look like a bad product.
  lines.sort((a, b) => {
    if (a.proposedQty > 0 !== b.proposedQty > 0) return a.proposedQty > 0 ? -1 : 1;
    const as = a.priorityScore ?? -1;
    const bs = b.priorityScore ?? -1;
    if (bs !== as) return bs - as;
    return b.paidUnits30d - a.paidUnits30d;
  });

  const proposed = lines.filter((l) => l.proposedQty > 0);
  const seededTotal = lines.reduce((t, l) => t + l.seededUnits30d, 0);
  const paidTotal = lines.reduce((t, l) => t + l.paidUnits30d, 0);

  if (seededTotal > 0 && paidTotal + seededTotal > 0) {
    const share = Math.round((seededTotal / (paidTotal + seededTotal)) * 1000) / 10;
    warnings.push(
      `${share}% of the last 30 days' units were giveaways (${seededTotal} of ${paidTotal + seededTotal}). ` +
      `Amazon's recommendations count those as demand; these proposals do not. Plan Vine units separately.`,
    );
  }

  const shortSkus = lines.filter((l) => l.shortfall > 0);
  if (shortSkus.length > 0) {
    warnings.push(
      `${shortSkus.length} SKU(s) are capped by warehouse stock — ` +
      `${shortSkus.reduce((t, l) => t + l.shortfall, 0)} units short of the paid-demand target. That is a purchasing signal.`,
    );
  }

  return {
    snapshotDate, coverDays, lines, warnings,
    totals: {
      skusConsidered: lines.length,
      skusProposed: proposed.length,
      proposedUnits: proposed.reduce((t, l) => t + l.proposedQty, 0),
      shortfallUnits: lines.reduce((t, l) => t + l.shortfall, 0),
      amazonRecommendedUnits: lines.reduce((t, l) => t + l.amazonRecommendedQty, 0),
      proposedCost: round2(
        proposed.reduce((t, l) => t + l.proposedQty * (l.landedCostPerUnit ?? 0), 0),
      ),
    },
  };
}
