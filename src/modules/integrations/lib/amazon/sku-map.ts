/**
 * One definition of "which catalog SKU does this spelling mean".
 *
 * The catalog spells a SKU JX3004-S-BLK, ShipHero reports JX3004-BLK and
 * Amazon reports JX3004-BLK-FBA. Every consumer has to resolve those the same
 * way as `resolveCatalogSku`, or a report contradicts the importer it exists
 * to explain.
 *
 * ⚠️ The subtlety that bit: a naive
 *
 *     SELECT sku AS spelling, id FROM catalog_skus
 *     UNION SELECT alias, sku_id FROM catalog_sku_aliases
 *
 * yields SEVERAL rows per catalog id — one per spelling. Joining anything
 * per-sku_id through it then multiplies rows, and the replenishment proposal
 * duly listed all 140 SKUs twice with a doubled total. UNION deduplicates
 * identical PAIRS, which is not the same as one row per id.
 *
 * So the map is one row per SPELLING (which is what a lookup needs), and any
 * per-sku_id aggregate must be grouped by sku_id BEFORE it is joined —
 * `WAREHOUSE_CTE` below does exactly that.
 *
 * Exact catalog SKUs win over aliases: an alias must never shadow a real SKU.
 */

/**
 * `sku_map(spelling, sku_id)` — one row per spelling.
 *
 * Starts a WITH clause; append further CTEs with a leading comma.
 */
export const SKU_MAP_CTE = `
  WITH sku_map AS (
    SELECT spelling, sku_id FROM (
      SELECT cs.sku AS spelling, cs.id AS sku_id, 0 AS rank
      FROM catalog_skus cs WHERE cs.sku IS NOT NULL AND cs.sku != ''
      UNION ALL
      SELECT a.alias, a.sku_id, 1 FROM catalog_sku_aliases a
    )
    GROUP BY spelling
    HAVING rank = MIN(rank)
  )`;

/**
 * `warehouse(sku_id, qty)` — one row per catalog SKU.
 *
 * Aggregated by sku_id before any join, so a SKU carrying several spellings
 * cannot multiply the rows of whatever joins to it.
 */
export const WAREHOUSE_CTE = `
  warehouse AS (
    SELECT sku_id, SUM(quantity) AS qty
    FROM inventory WHERE location = 'warehouse'
    GROUP BY sku_id
  )`;

/**
 * `cost(sku_id, landed)` — the next unit out under FIFO, which is what the
 * next unit shipped actually costs. One row per catalog SKU.
 */
export const COST_CTE = `
  cost AS (
    SELECT cl.sku_id AS sku_id,
           (SELECT x.landed_cost_per_unit FROM inventory_cost_layers x
             WHERE x.sku_id = cl.sku_id AND x.remaining_quantity > 0
             ORDER BY x.received_at ASC, x.created_at ASC LIMIT 1) AS landed
    FROM inventory_cost_layers cl GROUP BY cl.sku_id
  )`;
