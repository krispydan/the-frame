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
  matchedVia: "exact" | "alias" | "legacy-exact" | "legacy-alias" | "power-representative";
};

/**
 * Every spelling an EXTERNAL system might use for one of our SKUs, best
 * guess first.
 *
 * resolveCatalogSku() maps inbound strings onto catalog rows; this is the
 * other direction, for looking a SKU up in Shopify/Faire/Amazon. Same two
 * generations, same alias table — a catalog row reading JX4011-S-BLK is
 * very often JX4011-BLK on the storefront, and searching only the catalog
 * spelling finds nothing.
 *
 * Deduped and order-stable: callers try them in turn and stop at the
 * first hit, so the exact catalog SKU must lead.
 */
export function externalSkuCandidates(catalogSku: string | null | undefined, skuId?: string): string[] {
  const out: string[] = [];
  const push = (v: string | null | undefined) => {
    const s = (v ?? "").trim();
    if (s && !out.some((x) => x.toUpperCase() === s.toUpperCase())) out.push(s);
  };

  push(catalogSku);

  if (catalogSku) {
    const up = catalogSku.trim().toUpperCase();
    // JX4011-S-BLK → JX4011-BLK (and the reader equivalent).
    push(up.replace(/^(JX\d{4})-[SR]-/, "$1-"));
    // Per-power reader rows: JX1019-R-BLK-150 → JX1019-R-BLK → JX1019-BLK.
    const noPower = up.replace(/-(\d{3})$/, "");
    if (noPower !== up) {
      push(noPower);
      push(noPower.replace(/^(JX\d{4})-[SR]-/, "$1-"));
    }
  }

  // Anything a human has explicitly mapped wins over guessed forms, but
  // comes after the exact SKU.
  if (skuId) {
    const aliases = sqlite
      .prepare(`SELECT alias FROM catalog_sku_aliases WHERE sku_id = ?`)
      .all(skuId) as Array<{ alias: string }>;
    for (const a of aliases) push(a.alias);
  }

  return out;
}

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

  // Reader colorway with per-power rows only (catalog has JX1019-R-BLK-100…
  // -300 but no base JX1019-R-BLK row): resolve to the lowest power variant
  // as a deterministic representative. Forecasting rolls per-power rows up
  // to the colorway root, so aggregate math stays correct.
  if (/^JX\d{4}-R-[A-Z0-9]{2,4}$/.test(up)) {
    const rep = sqlite.prepare(
      "SELECT id, sku FROM catalog_skus WHERE UPPER(sku) LIKE ? ORDER BY sku LIMIT 1",
    ).get(`${up}-%`) as { id: string; sku: string } | undefined;
    if (rep) return { skuId: rep.id, catalogSku: rep.sku, matchedVia: "power-representative" };
  }

  return null;
}
