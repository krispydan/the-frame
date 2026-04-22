/**
 * Shared loader for warehouse/factory exports.
 *
 * Pulls SKU + product data grouped by factory prefix so ShipHero/Factory
 * CSV exports can filter by `factoryCode` (JX1, JX2, JX3, JX4) or grab
 * everything at once.
 */

import { db } from "@/lib/db";
import { products, skus } from "@/modules/catalog/schema";
import { and, eq, like, inArray, isNotNull } from "drizzle-orm";

export type WarehouseSku = {
  productId: string;
  productName: string;
  skuPrefix: string;
  factoryCode: string;          // JX1, JX2, JX3, JX4
  sku: string;                  // JX1001-BLK
  colorName: string | null;
  upc: string | null;
  weightOz: number | null;
  twelvePackSku: string | null;
  twelvePackUpc: string | null;
  shipheroSyncedAt: string | null;
};

export type LoadOpts = {
  /** Filter to one factory, e.g. "JX3". Omit for all. */
  factoryCode?: string;
  /** Only return SKUs whose twelve_pack_sku hasn't been synced to ShipHero. */
  newOnly?: boolean;
  /** Specific SKU list override. */
  skuList?: string[];
};

export async function loadWarehouseSkus(opts: LoadOpts = {}): Promise<WarehouseSku[]> {
  const conds = [];
  if (opts.factoryCode) {
    conds.push(like(products.skuPrefix, `${opts.factoryCode}%`));
  }
  if (opts.skuList && opts.skuList.length > 0) {
    conds.push(inArray(skus.sku, opts.skuList));
  }
  if (opts.newOnly) {
    // New means: has a twelve_pack_sku, never synced.
    conds.push(isNotNull(skus.twelvePackSku));
    // Drizzle's isNull() is not imported here; emulate with eq + passthrough:
    // Just filter in post-load to keep the query simple.
  }

  const rows = await db
    .select({
      productId: products.id,
      productName: products.name,
      skuPrefix: products.skuPrefix,
      sku: skus.sku,
      colorName: skus.colorName,
      upc: skus.upc,
      weightOz: skus.weightOz,
      twelvePackSku: skus.twelvePackSku,
      twelvePackUpc: skus.twelvePackUpc,
      shipheroSyncedAt: skus.shipheroSyncedAt,
    })
    .from(skus)
    .innerJoin(products, eq(skus.productId, products.id))
    .where(conds.length > 0 ? and(...conds) : undefined);

  const out: WarehouseSku[] = rows
    .filter((r) => r.sku && r.skuPrefix)
    .map((r) => ({
      productId: r.productId!,
      productName: r.productName ?? "",
      skuPrefix: r.skuPrefix!,
      factoryCode: r.skuPrefix!.slice(0, 3),  // JX1, JX2, JX3, JX4
      sku: r.sku!,
      colorName: r.colorName,
      upc: r.upc,
      weightOz: r.weightOz,
      twelvePackSku: r.twelvePackSku,
      twelvePackUpc: r.twelvePackUpc,
      shipheroSyncedAt: r.shipheroSyncedAt,
    }));

  return opts.newOnly
    ? out.filter((r) => r.twelvePackSku && !r.shipheroSyncedAt)
    : out;
}
