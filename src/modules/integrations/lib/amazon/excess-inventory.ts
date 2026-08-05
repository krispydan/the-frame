/**
 * The other half of replenishment: what NOT to send, and what to pull back.
 *
 * A restocking report that only ever says "send more" is half a report. Stock
 * sitting at Amazon costs storage every month, ages into long-term storage
 * fees, and ties up cash in units that are not selling — none of which shows
 * up anywhere else, because it is an absence of transactions rather than a
 * transaction.
 *
 * Built from the restock snapshot and the FBA inventory snapshot, both of
 * which we already hold. Amazon's own `get_fba_inventory_planning_data` would
 * add long-term storage fee projections and its own excess estimate, but its
 * usable field family carries no SKU key — every identifier probed
 * (sku, asin, msku, merchant-sku, seller-sku, fnsku) fails to resolve
 * alongside it, so 78 rows come back with nothing to join them to. Recorded
 * here so the next person does not repeat the search.
 *
 * ⚠️ Velocity is PAID velocity throughout, for the same reason as
 * replenishment: Amazon's own units-sold counts Vine giveaways, and a SKU
 * kept alive by giveaways is precisely the one that looks healthy and is not.
 */

import { sqlite } from "@/lib/db";
import { SKU_MAP_CTE, COST_CTE, INTERNAL_SKU } from "./sku-map";

/** Days of cover beyond which stock is excess rather than prudent. */
export const EXCESS_COVER_DAYS = 180;

/** Cover beyond which a SKU is effectively dead at Amazon. */
export const DEAD_COVER_DAYS = 365;

export type ExcessReason =
  | "no_paid_sales"
  | "excess_cover"
  | "unfulfillable"
  | "giveaway_propped";

export interface ExcessLine {
  sku: string;
  asin: string | null;
  title: string | null;
  /** Units sellable at Amazon right now. */
  fbaAvailable: number;
  /** Units Amazon holds but cannot sell — damaged, mislabelled. */
  unfulfillable: number;
  paidUnits30d: number;
  seededUnits30d: number;
  /** fbaAvailable ÷ paid daily rate. Null when nothing is selling. */
  daysOfCover: number | null;
  /** Units above the excess threshold. What could come back. */
  excessUnits: number;
  landedCostPerUnit: number | null;
  /** Capital tied up in the excess, at cost. */
  excessValueAtCost: number;
  reasons: ExcessReason[];
  /** Ranked by capital at risk, so the biggest problem reads first. */
  priority: number;
}

export interface ExcessReport {
  snapshotDate: string | null;
  lines: ExcessLine[];
  totals: {
    skusFlagged: number;
    excessUnits: number;
    excessValueAtCost: number;
    unfulfillableUnits: number;
  };
  notes: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildExcessReport(opts?: {
  coverDays?: number;
  today?: string;
}): ExcessReport {
  const coverLimit = opts?.coverDays ?? EXCESS_COVER_DAYS;
  const today = opts?.today ?? new Date().toISOString().slice(0, 10);
  const windowStart = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86_400_000)
    .toISOString().slice(0, 10);

  const snapshotDate = (sqlite.prepare(
    "SELECT MAX(snapshot_date) AS d FROM amazon_restock_recommendations",
  ).get() as { d: string | null }).d;

  const notes: string[] = [];
  if (!snapshotDate) {
    return {
      snapshotDate: null, lines: [],
      totals: { skusFlagged: 0, excessUnits: 0, excessValueAtCost: 0, unfulfillableUnits: 0 },
      notes: ["No restock snapshot held — run the restock sync first."],
    };
  }

  const rows = sqlite.prepare(`
    ${SKU_MAP_CTE},
    -- Keyed on the INTERNAL spelling: one product listed both merchant and
    -- FBA must have its demand summed, not split.
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
    ${COST_CTE}
    -- One row per PRODUCT. MAX on the position because both listings report
    -- the same physical stock — summing would double every excess unit and
    -- every dollar of capital reported as at risk.
    SELECT MAX(rr.sku) AS sku, MAX(rr.asin) AS asin, MAX(rr.product_name) AS amazonTitle,
           MAX(rr.available) AS fbaAvailable, MAX(rr.unfulfillable) AS unfulfillable,
           IFNULL(MAX(v.paidUnits), 0) AS paidUnits30d,
           IFNULL(MAX(v.seededUnits), 0) AS seededUnits30d,
           MAX(c.landed) AS landedCostPerUnit
    FROM amazon_restock_recommendations rr
    LEFT JOIN sku_map m  ON m.spelling = rr.internal_sku
    LEFT JOIN cost c     ON c.sku_id = m.sku_id
    LEFT JOIN velocity v ON v.sku = rr.internal_sku
    WHERE rr.snapshot_date = ?
    GROUP BY rr.internal_sku
  `).all(windowStart, today, snapshotDate) as Array<{
    sku: string; asin: string | null; amazonTitle: string | null;
    fbaAvailable: number; unfulfillable: number;
    paidUnits30d: number; seededUnits30d: number; landedCostPerUnit: number | null;
  }>;

  const titles = new Map<string, string>();
  for (const t of sqlite.prepare(
    "SELECT internal_sku AS sku, title FROM amazon_listings WHERE internal_sku IS NOT NULL AND title IS NOT NULL",
  ).all() as Array<{ sku: string; title: string }>) {
    titles.set(t.sku, t.title);
  }

  const lines: ExcessLine[] = [];
  for (const r of rows) {
    const reasons: ExcessReason[] = [];
    const perDay = r.paidUnits30d / 30;
    const daysOfCover = perDay > 0 ? Math.round(r.fbaAvailable / perDay) : null;

    let excessUnits = 0;

    if (r.fbaAvailable > 0 && r.paidUnits30d === 0) {
      // Nothing paid in a month with stock sitting there. All of it is excess
      // until something sells.
      reasons.push("no_paid_sales");
      excessUnits = r.fbaAvailable;
    } else if (daysOfCover !== null && daysOfCover > coverLimit) {
      reasons.push("excess_cover");
      // Keep the cover limit; everything past it is the excess.
      excessUnits = Math.max(0, r.fbaAvailable - Math.ceil(perDay * coverLimit));
    }

    // A SKU whose only movement is giveaway looks alive in Amazon's numbers
    // and is not. Worth naming separately from "no sales at all".
    if (r.seededUnits30d > 0 && r.paidUnits30d === 0) {
      reasons.push("giveaway_propped");
    }

    if (r.unfulfillable > 0) reasons.push("unfulfillable");

    if (reasons.length === 0) continue;

    const landed = r.landedCostPerUnit;
    const excessValueAtCost = round2(excessUnits * (landed ?? 0));

    lines.push({
      sku: r.sku, asin: r.asin,
      title: titles.get(r.sku.replace(/-FBA$/i, "")) ?? r.amazonTitle,
      fbaAvailable: r.fbaAvailable,
      unfulfillable: r.unfulfillable,
      paidUnits30d: r.paidUnits30d,
      seededUnits30d: r.seededUnits30d,
      daysOfCover,
      excessUnits,
      landedCostPerUnit: landed !== null ? round2(landed) : null,
      excessValueAtCost,
      reasons,
      // Capital at risk. Where cost is unknown, fall back to unit count so a
      // large uncosted pile still surfaces rather than sorting to the bottom.
      priority: excessValueAtCost > 0 ? excessValueAtCost : excessUnits,
    });
  }

  lines.sort((a, b) => b.priority - a.priority);

  const noCost = lines.filter((l) => l.landedCostPerUnit === null).length;
  if (noCost > 0) {
    notes.push(`${noCost} SKU(s) have no FIFO layer, so their capital at risk is understated — they are ranked by unit count instead.`);
  }
  notes.push(
    `Cover is computed from PAID velocity. Amazon's own units-sold counts Vine giveaways, and a SKU kept ` +
    `alive by giveaways is exactly the one that looks healthy and is not.`,
  );
  notes.push(
    "Long-term storage fee projections are not included: Amazon's inventory-planning report exposes them, " +
    "but its usable field family carries no SKU key, so the rows cannot be joined to a product.",
  );

  return {
    snapshotDate, lines, notes,
    totals: {
      skusFlagged: lines.length,
      excessUnits: lines.reduce((t, l) => t + l.excessUnits, 0),
      excessValueAtCost: round2(lines.reduce((t, l) => t + l.excessValueAtCost, 0)),
      unfulfillableUnits: lines.reduce((t, l) => t + l.unfulfillable, 0),
    },
  };
}
