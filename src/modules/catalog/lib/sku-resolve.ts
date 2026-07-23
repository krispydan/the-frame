/**
 * Flexible catalog SKU resolution.
 *
 * The catalog carries two SKU generations:
 *   - legacy:  JX1001-BLK        (no product-type segment)
 *   - current: JX1008-S-BLK / JX1019-R-BLK[-150|-BL]  (S/R segment)
 *
 * Factory sheets and sales channels mix both, so resolution tries:
 *   1. exact catalog match (case-insensitive)
 *   2. catalog_sku_aliases
 *   3. the same two lookups on the format-swapped variant
 *      (strip "-S-"/"-R-" → legacy, or inject nothing — legacy inputs only
 *      match new-format rows via aliases)
 */

import { sqlite } from "@/lib/db";

export type SkuResolution = {
  skuId: string;
  /** The catalog row's actual sku string. */
  catalogSku: string;
  matchedVia: "exact" | "alias" | "legacy-exact" | "legacy-alias";
};

export function resolveCatalogSku(raw: string | null | undefined): SkuResolution | null {
  if (!raw) return null;
  const up = raw.trim().toUpperCase();
  if (!up) return null;

  const exact = sqlite.prepare(
    "SELECT id, sku FROM catalog_skus WHERE UPPER(sku) = ? LIMIT 1",
  ).get(up) as { id: string; sku: string } | undefined;
  if (exact) return { skuId: exact.id, catalogSku: exact.sku, matchedVia: "exact" };

  const alias = sqlite.prepare(
    `SELECT a.sku_id, s.sku FROM catalog_sku_aliases a
     JOIN catalog_skus s ON s.id = a.sku_id
     WHERE UPPER(a.alias) = ? LIMIT 1`,
  ).get(up) as { sku_id: string; sku: string } | undefined;
  if (alias) return { skuId: alias.sku_id, catalogSku: alias.sku, matchedVia: "alias" };

  // Legacy fallback: JX1008-S-BLK → JX1008-BLK (also strips reader power
  // suffixes' base form: JX1019-R-BLK → JX1019-BLK).
  const legacy = up.replace(/^(JX\d{4})-[SR]-/, "$1-");
  if (legacy !== up) {
    const lexact = sqlite.prepare(
      "SELECT id, sku FROM catalog_skus WHERE UPPER(sku) = ? LIMIT 1",
    ).get(legacy) as { id: string; sku: string } | undefined;
    if (lexact) return { skuId: lexact.id, catalogSku: lexact.sku, matchedVia: "legacy-exact" };

    const lalias = sqlite.prepare(
      `SELECT a.sku_id, s.sku FROM catalog_sku_aliases a
       JOIN catalog_skus s ON s.id = a.sku_id
       WHERE UPPER(a.alias) = ? LIMIT 1`,
    ).get(legacy) as { sku_id: string; sku: string } | undefined;
    if (lalias) return { skuId: lalias.sku_id, catalogSku: lalias.sku, matchedVia: "legacy-alias" };
  }

  return null;
}
