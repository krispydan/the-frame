/**
 * FIFO-vs-physical drift diagnostics.
 *
 * The Amazon month-end check reports one number — "FIFO holds N units but
 * physical stock is M" — which tells you something is wrong but not what.
 * That single number has two very different causes and the fix is opposite
 * in each case:
 *
 *   Drift is concentrated in a few SKUs  → real: sales went uncosted, or a
 *                                          transfer was costed as a sale.
 *   Drift is spread across the catalog   → baseline: cost layers were seeded
 *                                          from full PO history while
 *                                          depletions only exist from the day
 *                                          COGS costing went live.
 *
 * The second is by far the more common shape on a system that started costing
 * partway through its life, and it is NOT an accounting error to chase — it is
 * an opening-balance question. Distinguishing the two is what this module is
 * for, so nobody spends a close hunting a missing depletion that never existed.
 *
 * Read-only. Nothing here writes.
 */

import { sqlite } from "@/lib/db";

export type SkuDrift = {
  skuId: string;
  sku: string | null;
  productName: string | null;
  colorName: string | null;
  /** Units FIFO believes we still own. */
  fifoRemaining: number;
  /** Units ShipHero reports on hand (inventory.location = 'warehouse'). */
  warehouse: number;
  /** Units Amazon reports in FBA, latest snapshot. */
  fba: number;
  physical: number;
  /** fifoRemaining − physical. Positive = FIFO overstates. */
  drift: number;
  /** Units ever layered in, and units ever depleted out. */
  layered: number;
  depleted: number;
  /** Date of the earliest depletion for this SKU — i.e. when costing began. */
  firstDepletionAt: string | null;
};

/**
 * What each upstream feed actually holds, before any mapping.
 *
 * The per-SKU view can only show stock it managed to join to a catalog SKU,
 * so "physical is zero" there is ambiguous: the feed could be empty, or the
 * feed could be full and the join broken. These are the raw numbers, which
 * separate the two — and they are the difference between chasing a costing
 * bug and chasing a sync bug.
 */
export type SourceReport = {
  shiphero: {
    /** Rows in the raw ShipHero table, and units across them. */
    rows: number;
    onHand: number;
    lastSyncedAt: string | null;
    /** Units the raw feed holds for SKUs that never mapped into `inventory`. */
    unmappedOnHand: number;
    unmappedExamples: string[];
  };
  /** Units in `inventory` at location='warehouse' — what the checks read. */
  mappedWarehouse: number;
  fba: {
    rows: number;
    totalQty: number;
    snapshotDate: string | null;
    /** FBA SKUs that match no catalog SKU under any spelling. */
    unmatchedQty: number;
    unmatchedExamples: string[];
  };
};

export type DriftReport = {
  sources: SourceReport;
  totals: {
    fifoRemaining: number;
    warehouse: number;
    fba: number;
    physical: number;
    drift: number;
  };
  /** How the drift is distributed — the part that names the cause. */
  shape: {
    skusWithDrift: number;
    skusTotal: number;
    /** Share of total positive drift held by the 5 worst SKUs. */
    top5Share: number;
    /** Earliest depletion anywhere. Layers received before this predate costing. */
    costingStartedAt: string | null;
    /** Units on layers received before costing started — the opening balance
     *  that was never going to be depleted by this system. */
    preCostingUnitsRemaining: number;
    verdict: "baseline" | "concentrated" | "clean";
    explanation: string;
  };
  skus: SkuDrift[];
};

/**
 * Per-SKU FIFO vs physical, plus the shape of the distribution.
 *
 * `limit` caps the returned SKU rows (worst drift first); the totals and shape
 * are always computed over the whole catalog regardless.
 */
export function buildDriftReport(opts?: { limit?: number }): DriftReport {
  const limit = opts?.limit ?? 50;

  const rows = sqlite.prepare(`
    WITH latest_fba AS (
      SELECT sku, MAX(snapshot_date) AS d FROM amazon_fba_inventory GROUP BY sku
    ),
    fba AS (
      SELECT f.sku AS sku, f.internal_sku AS internal_sku, SUM(f.total_qty) AS qty
      FROM amazon_fba_inventory f
      JOIN latest_fba l ON l.sku = f.sku AND l.d = f.snapshot_date
      GROUP BY f.sku, f.internal_sku
    ),
    layers AS (
      SELECT sku_id,
             SUM(remaining_quantity) AS remaining,
             SUM(quantity) AS layered,
             SUM(quantity) - SUM(remaining_quantity) AS depleted
      FROM inventory_cost_layers GROUP BY sku_id
    ),
    firstdep AS (
      SELECT cl.sku_id AS sku_id, MIN(d.depleted_at) AS first_at
      FROM inventory_cost_depletions d
      JOIN inventory_cost_layers cl ON cl.id = d.cost_layer_id
      GROUP BY cl.sku_id
    ),
    wh AS (
      SELECT sku_id, SUM(quantity) AS qty FROM inventory
      WHERE location = 'warehouse' GROUP BY sku_id
    )
    SELECT
      cs.id                       AS skuId,
      cs.sku                      AS sku,
      cp.name                     AS productName,
      cs.color_name               AS colorName,
      IFNULL(layers.remaining, 0) AS fifoRemaining,
      IFNULL(layers.layered, 0)   AS layered,
      IFNULL(layers.depleted, 0)  AS depleted,
      IFNULL(wh.qty, 0)           AS warehouse,
      IFNULL(fba.qty, 0)          AS fba,
      firstdep.first_at           AS firstDepletionAt
    FROM catalog_skus cs
    LEFT JOIN catalog_products cp ON cp.id = cs.product_id
    LEFT JOIN layers   ON layers.sku_id = cs.id
    LEFT JOIN firstdep ON firstdep.sku_id = cs.id
    LEFT JOIN wh       ON wh.sku_id = cs.id
    -- FBA reports the Amazon-facing SKU, which carries a -FBA suffix for
    -- stock we send in. The ingest already resolves that to internal_sku;
    -- match on it first and fall back to the raw spellings.
    LEFT JOIN fba ON fba.internal_sku = cs.sku
                  OR fba.sku = cs.sku
                  OR fba.sku = cs.sku || '-FBA'
    WHERE IFNULL(layers.remaining, 0) != 0
       OR IFNULL(wh.qty, 0) != 0
       OR IFNULL(fba.qty, 0) != 0
  `).all() as Array<Omit<SkuDrift, "physical" | "drift">>;

  const skus: SkuDrift[] = rows.map((r) => {
    const physical = r.warehouse + r.fba;
    return { ...r, physical, drift: r.fifoRemaining - physical };
  });

  const totals = skus.reduce(
    (acc, s) => ({
      fifoRemaining: acc.fifoRemaining + s.fifoRemaining,
      warehouse: acc.warehouse + s.warehouse,
      fba: acc.fba + s.fba,
      physical: acc.physical + s.physical,
      drift: acc.drift + s.drift,
    }),
    { fifoRemaining: 0, warehouse: 0, fba: 0, physical: 0, drift: 0 },
  );

  // ── Shape ──
  const positive = skus.filter((s) => s.drift > 0).sort((a, b) => b.drift - a.drift);
  const positiveTotal = positive.reduce((t, s) => t + s.drift, 0);
  const top5 = positive.slice(0, 5).reduce((t, s) => t + s.drift, 0);
  const top5Share = positiveTotal > 0 ? Math.round((top5 / positiveTotal) * 1000) / 10 : 0;

  const costingStartedAt = (sqlite.prepare(
    "SELECT MIN(depleted_at) AS d FROM inventory_cost_depletions",
  ).get() as { d: string | null }).d;

  // The opening balance: layers received before costing began that costing
  // never touched. Both halves matter. Received-before alone is too broad —
  // a layer received the week before the first sale is squarely in scope and
  // gets drawn down normally. It is the layers with no depletion at all,
  // sitting behind the FIFO queue since before the system existed, that were
  // never going to clear.
  const preCostingUnitsRemaining = costingStartedAt
    ? (sqlite.prepare(`
      SELECT IFNULL(SUM(cl.remaining_quantity), 0) AS n
      FROM inventory_cost_layers cl
      WHERE cl.received_at < ?
        AND NOT EXISTS (SELECT 1 FROM inventory_cost_depletions d WHERE d.cost_layer_id = cl.id)
    `).get(costingStartedAt) as { n: number }).n
    : 0;

  const skusWithDrift = skus.filter((s) => s.drift !== 0).length;

  let verdict: DriftReport["shape"]["verdict"];
  let explanation: string;

  if (Math.abs(totals.drift) <= Math.max(25, Math.round(totals.physical * 0.05))) {
    verdict = "clean";
    explanation = "Drift is within tolerance. Nothing to chase.";
  } else if (preCostingUnitsRemaining >= totals.drift * 0.8) {
    verdict = "baseline";
    explanation =
      `${preCostingUnitsRemaining} of the ${totals.drift}-unit drift sits on layers received before ` +
      `${costingStartedAt ?? "costing began"} — stock this system was never going to deplete because ` +
      `it predates FIFO costing. This is an opening-balance gap, not a missed sale. The fix is a ` +
      `one-off write-down of pre-costing layers to the physical count, not a depletion run.`;
  } else if (top5Share >= 60) {
    verdict = "concentrated";
    explanation =
      `${top5Share}% of the drift sits in 5 SKUs. That pattern means specific sales went uncosted or ` +
      `a transfer was costed as a sale — check those SKUs' orders rather than the catalog as a whole.`;
  } else {
    verdict = "concentrated";
    explanation =
      `Drift is spread across ${skusWithDrift} SKUs but is not explained by pre-costing layers. ` +
      `Run the uncosted-order depletion as a dry run to see whether shipped orders are missing costs.`;
  }

  return {
    sources: buildSourceReport(),
    totals,
    shape: {
      skusWithDrift,
      skusTotal: skus.length,
      top5Share,
      costingStartedAt,
      preCostingUnitsRemaining,
      verdict,
      explanation,
    },
    skus: skus.sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift)).slice(0, limit),
  };
}

/** Raw feed totals, independent of any catalog join. */
export function buildSourceReport(): SourceReport {
  const sh = sqlite.prepare(`
    SELECT COUNT(*) AS rows, IFNULL(SUM(on_hand), 0) AS onHand, MAX(synced_at) AS lastSyncedAt
    FROM shiphero_inventory
  `).get() as { rows: number; onHand: number; lastSyncedAt: string | null };

  // ShipHero SKUs the mapper never landed in `inventory`. A large number here
  // with healthy raw stock is a mapping failure, not missing stock.
  const unmapped = sqlite.prepare(`
    SELECT si.sku AS sku, SUM(si.on_hand) AS qty
    FROM shiphero_inventory si
    WHERE si.on_hand > 0
      AND NOT EXISTS (
        SELECT 1 FROM catalog_skus cs
        JOIN inventory i ON i.sku_id = cs.id AND i.location = 'warehouse' AND i.quantity > 0
        WHERE cs.sku = si.sku
      )
    GROUP BY si.sku
    ORDER BY qty DESC
  `).all() as Array<{ sku: string; qty: number }>;

  const mappedWarehouse = (sqlite.prepare(
    "SELECT IFNULL(SUM(quantity), 0) AS n FROM inventory WHERE location = 'warehouse'",
  ).get() as { n: number }).n;

  const snapshotDate = (sqlite.prepare(
    "SELECT MAX(snapshot_date) AS d FROM amazon_fba_inventory",
  ).get() as { d: string | null }).d;

  const fbaAgg = snapshotDate
    ? sqlite.prepare(
      "SELECT COUNT(*) AS rows, IFNULL(SUM(total_qty), 0) AS totalQty FROM amazon_fba_inventory WHERE snapshot_date = ?",
    ).get(snapshotDate) as { rows: number; totalQty: number }
    : { rows: 0, totalQty: 0 };

  const fbaUnmatched = snapshotDate
    ? sqlite.prepare(`
      SELECT f.sku AS sku, f.total_qty AS qty
      FROM amazon_fba_inventory f
      WHERE f.snapshot_date = ? AND f.total_qty > 0
        AND NOT EXISTS (
          SELECT 1 FROM catalog_skus cs
          WHERE cs.sku = f.internal_sku OR cs.sku = f.sku OR cs.sku || '-FBA' = f.sku
        )
      ORDER BY f.total_qty DESC
    `).all(snapshotDate) as Array<{ sku: string; qty: number }>
    : [];

  return {
    shiphero: {
      rows: sh.rows,
      onHand: sh.onHand,
      lastSyncedAt: sh.lastSyncedAt,
      unmappedOnHand: unmapped.reduce((t, r) => t + r.qty, 0),
      unmappedExamples: unmapped.slice(0, 10).map((r) => `${r.sku} (${r.qty})`),
    },
    mappedWarehouse,
    fba: {
      rows: fbaAgg.rows,
      totalQty: fbaAgg.totalQty,
      snapshotDate,
      unmatchedQty: fbaUnmatched.reduce((t, r) => t + r.qty, 0),
      unmatchedExamples: fbaUnmatched.slice(0, 10).map((r) => `${r.sku} (${r.qty})`),
    },
  };
}

export type CoverageReport = {
  uncostedItems: number;
  uncostedUnits: number;
  byChannel: Array<{ channel: string; items: number; units: number; oldestShippedAt: string | null }>;
  oldestShippedAt: string | null;
  /** Uncosted lines whose SKU has no cost layers at all — depletion cannot
   *  fix these, they need a PO/cost layer first. */
  unlayeredSkus: Array<{ sku: string; units: number }>;
};

/**
 * Shipped order lines carrying no FIFO depletion — i.e. revenue booked with
 * no cost against it. Split by channel because a single channel lighting up
 * points at that channel's importer, while all channels at once points at the
 * costing job itself.
 */
export function buildCoverageReport(opts?: { since?: string }): CoverageReport {
  const since = opts?.since ?? "2020-01-01";

  const byChannel = sqlite.prepare(`
    SELECT o.channel AS channel,
           COUNT(*) AS items,
           IFNULL(SUM(oi.quantity), 0) AS units,
           MIN(o.shipped_at) AS oldestShippedAt
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN inventory_cost_depletions d ON d.order_item_id = oi.id
    WHERE o.status IN ('shipped', 'delivered')
      AND o.shipped_at >= ?
      AND oi.sku_id IS NOT NULL
      AND d.id IS NULL
    GROUP BY o.channel
    ORDER BY units DESC
  `).all(since) as CoverageReport["byChannel"];

  const unlayeredSkus = sqlite.prepare(`
    SELECT oi.sku AS sku, IFNULL(SUM(oi.quantity), 0) AS units
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN inventory_cost_depletions d ON d.order_item_id = oi.id
    WHERE o.status IN ('shipped', 'delivered')
      AND o.shipped_at >= ?
      AND oi.sku_id IS NOT NULL
      AND d.id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM inventory_cost_layers cl
        WHERE cl.sku_id = oi.sku_id AND cl.remaining_quantity > 0
      )
    GROUP BY oi.sku
    ORDER BY units DESC
    LIMIT 50
  `).all(since) as CoverageReport["unlayeredSkus"];

  return {
    uncostedItems: byChannel.reduce((t, c) => t + c.items, 0),
    uncostedUnits: byChannel.reduce((t, c) => t + c.units, 0),
    byChannel,
    oldestShippedAt: byChannel.reduce<string | null>(
      (min, c) => (c.oldestShippedAt && (!min || c.oldestShippedAt < min) ? c.oldestShippedAt : min),
      null,
    ),
    unlayeredSkus,
  };
}
