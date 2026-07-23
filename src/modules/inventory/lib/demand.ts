/**
 * Unit-level demand resolution for inventory forecasting.
 *
 * The naive velocity queries (`GROUP BY order_items.sku_id`) miss two big
 * demand sources:
 *   1. Faire/wholesale order lines are stored with only the `sku` TEXT (no
 *      sku_id FK), so they vanish from any sku_id GROUP BY — i.e. most
 *      wholesale demand was invisible to the forecast.
 *   2. 12-pack lines (`JX1001-BLK-12PK` qty 4) are really 48 units of the
 *      unit SKU.
 *
 * This module resolves every order line through the same
 * resolveDepletionTarget used by the FIFO/COGS engine (pack math + alias
 * map), then rolls demand up to a FORECAST ROOT SKU:
 *
 *   JX1008-S-BLK        → JX1008-S-BLK        (sunglasses colorway)
 *   JX1019-R-BLK-150    → JX1019-R-BLK        (reader power variant → colorway)
 *   JX1019-R-BLK-BL     → JX1019-R-BLK        (blue-light variant → colorway)
 *   JX1001-BLK-12PK     → JX1001-BLK          (pack → unit, via unitSkuOf)
 *
 * Factories are ordered at the colorway level (with a per-power split decided
 * at PO time), so the colorway root is the correct grain for reorder planning.
 */

import { sqlite } from "@/lib/db";
import { resolveDepletionTarget } from "@/modules/finance/lib/fifo-engine";
import { unitSkuOf } from "@/modules/finance/lib/pack-size";
import { resolveCatalogSku } from "@/modules/catalog/lib/sku-resolve";

/** JX SKU shape: JX<4 digits>-<S|R>-<color code>[-power/BL suffix] */
const ROOT_PATTERN = /^(JX\d{4}-[SR]-[A-Z0-9]{2,4})(?:-.+)?$/i;

/** Collapse a catalog SKU string to its forecast root (colorway). */
export function rootSkuOf(sku: string | null | undefined): string | null {
  if (!sku) return null;
  const bare = unitSkuOf(sku.trim().toUpperCase()) ?? sku.trim().toUpperCase();
  const m = ROOT_PATTERN.exec(bare);
  return m ? m[1].toUpperCase() : bare;
}

export interface RootDemandRow {
  rootSku: string;
  units: number;
}

type OrderLine = { sku: string | null; sku_id: string | null; quantity: number; channel: string };

/**
 * Total units sold per root SKU in the trailing window, across ALL channels
 * (Shopify DTC + wholesale + Faire + direct/phone). Excludes cancelled and
 * returned orders.
 */
export function getRootDemandForWindow(windowDays: number): Map<string, number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  return aggregateLines(fetchLines(cutoff.toISOString()));
}

/**
 * Weekly demand buckets per root SKU for the trailing `weeks` full weeks —
 * used for demand-variability (safety stock). Index 0 = oldest week.
 */
export function getWeeklyDemandSeries(weeks: number): Map<string, number[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - weeks * 7);
  const cutoffMs = cutoff.getTime();
  const lines = fetchLinesWithDates(cutoff.toISOString());

  const series = new Map<string, number[]>();
  const resolver = makeResolver();
  for (const line of lines) {
    const root = resolver(line.sku, line.sku_id);
    if (!root) continue;
    const placedMs = Date.parse(line.placed_at);
    if (!Number.isFinite(placedMs)) continue;
    const weekIdx = Math.min(weeks - 1, Math.max(0, Math.floor((placedMs - cutoffMs) / (7 * 24 * 3600 * 1000))));
    let arr = series.get(root);
    if (!arr) {
      arr = new Array(weeks).fill(0);
      series.set(root, arr);
    }
    arr[weekIdx] += lineUnits(line.sku, line.quantity);
  }
  return series;
}

/**
 * Monthly seasonality factors learned from the full order history.
 * factor[month] = avg daily units in that month / overall avg daily units,
 * damped 50/50 toward 1.0 and clamped to [0.5, 1.8] so a thin history can't
 * produce wild swings. Months with no data get the fallback factor.
 * Returns null if fewer than `minMonths` distinct months have sales — caller
 * should fall back to the hardcoded curve.
 */
export function getLearnedSeasonality(minMonths = 8): Record<number, number> | null {
  const rows = sqlite.prepare(`
    SELECT strftime('%Y-%m', o.placed_at) AS ym,
           strftime('%m', o.placed_at) AS month,
           SUM(oi.quantity) AS units
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    WHERE o.status NOT IN ('cancelled', 'returned')
      AND o.placed_at IS NOT NULL
    GROUP BY ym
  `).all() as Array<{ ym: string; month: string; units: number }>;

  // Drop the current (partial) month — it biases the factor downward.
  const nowYm = new Date().toISOString().slice(0, 7);
  const complete = rows.filter((r) => r.ym !== nowYm && r.units > 0);
  if (complete.length < minMonths) return null;

  const byMonth = new Map<number, { units: number; count: number }>();
  let total = 0;
  for (const r of complete) {
    const m = parseInt(r.month, 10);
    const cur = byMonth.get(m) ?? { units: 0, count: 0 };
    cur.units += r.units;
    cur.count += 1;
    byMonth.set(m, cur);
    total += r.units;
  }
  const overallAvg = total / complete.length;
  if (overallAvg <= 0) return null;

  const factors: Record<number, number> = {};
  for (let m = 1; m <= 12; m++) {
    const cur = byMonth.get(m);
    if (!cur) continue;
    const raw = (cur.units / cur.count) / overallAvg;
    const damped = 1 + (raw - 1) * 0.5; // 50% shrink toward 1.0
    factors[m] = Math.min(1.8, Math.max(0.5, Math.round(damped * 100) / 100));
  }
  return factors;
}

// ── internals ──

function fetchLines(cutoffIso: string): OrderLine[] {
  return sqlite.prepare(`
    SELECT oi.sku, oi.sku_id, oi.quantity, o.channel
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    WHERE o.placed_at >= ?
      AND o.status NOT IN ('cancelled', 'returned')
  `).all(cutoffIso) as OrderLine[];
}

function fetchLinesWithDates(cutoffIso: string): Array<OrderLine & { placed_at: string }> {
  return sqlite.prepare(`
    SELECT oi.sku, oi.sku_id, oi.quantity, o.channel, o.placed_at
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    WHERE o.placed_at >= ?
      AND o.status NOT IN ('cancelled', 'returned')
  `).all(cutoffIso) as Array<OrderLine & { placed_at: string }>;
}

function lineUnits(sku: string | null, quantity: number): number {
  // resolveDepletionTarget also multiplies, but for aggregation we only need
  // the pack multiple — avoid a second resolver pass.
  const m = /-(\d+)PK$/i.exec((sku ?? "").trim());
  const pack = m ? parseInt(m[1], 10) : 1;
  return quantity * (Number.isFinite(pack) && pack > 0 ? pack : 1);
}

/**
 * Returns a memoized (sku text, sku_id) → root SKU resolver. Resolution order:
 *   1. sku string → resolveDepletionTarget (packs + exact catalog + aliases)
 *   2. sku_id → catalog_skus lookup (Shopify lines that carry only the FK)
 * Unresolvable lines (freebies, discontinued, typos) return null.
 */
function makeResolver(): (sku: string | null, skuId: string | null) => string | null {
  const bySku = new Map<string, string | null>();
  const byId = new Map<string, string | null>();
  const skuOfId = sqlite.prepare("SELECT sku FROM catalog_skus WHERE id = ? LIMIT 1");
  const skuOfUnitId = sqlite.prepare("SELECT sku FROM catalog_skus WHERE id = ? LIMIT 1");

  return (sku, skuId) => {
    const key = (sku ?? "").trim().toUpperCase();
    if (key) {
      if (bySku.has(key)) return bySku.get(key)!;
      const resolved = resolveDepletionTarget({ sku: key, skuId: null, quantity: 1 });
      let root: string | null = null;
      if (resolved.unitSkuId) {
        const row = skuOfUnitId.get(resolved.unitSkuId) as { sku: string } | undefined;
        root = rootSkuOf(row?.sku ?? resolved.unitSku ?? key);
      } else {
        // Legacy-format fallback (JX1008-S-BLK ↔ JX1008-BLK), then bucket by
        // the SKU's own root shape so demand stays visible even unmapped.
        const flex = resolveCatalogSku(resolved.unitSku ?? key);
        if (flex) root = rootSkuOf(flex.catalogSku);
        else root = ROOT_PATTERN.test(key) ? rootSkuOf(key) : null;
      }
      bySku.set(key, root);
      if (root) return root;
    }
    if (skuId) {
      if (byId.has(skuId)) return byId.get(skuId)!;
      const row = skuOfId.get(skuId) as { sku: string } | undefined;
      const root = row?.sku ? rootSkuOf(row.sku) : null;
      byId.set(skuId, root);
      return root;
    }
    return null;
  };
}

function aggregateLines(lines: OrderLine[]): Map<string, number> {
  const resolver = makeResolver();
  const out = new Map<string, number>();
  for (const line of lines) {
    const root = resolver(line.sku, line.sku_id);
    if (!root) continue;
    out.set(root, (out.get(root) ?? 0) + lineUnits(line.sku, line.quantity));
  }
  return out;
}
