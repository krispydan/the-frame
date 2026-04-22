/**
 * Load products from DB in ExportProduct format.
 */
import { db } from "@/lib/db";
import { sqlite } from "@/lib/db";
import { products, skus, images, imageTypes, tags } from "@/modules/catalog/schema";
import { eq, inArray } from "drizzle-orm";
import type { ExportProduct } from "./types";

export async function loadExportProducts(productIds?: string[]): Promise<ExportProduct[]> {
  const allProducts = productIds
    ? await db.select().from(products).where(inArray(products.id, productIds))
    : await db.select().from(products);

  const pIds = allProducts.map((p) => p.id);
  if (pIds.length === 0) return [];

  const allSkus = await db.select().from(skus).where(inArray(skus.productId, pIds));
  const allSkuIds = allSkus.map((s) => s.id);
  const allImagesRaw = allSkuIds.length > 0
    ? await db
        .select({
          id: images.id, skuId: images.skuId, filePath: images.filePath,
          width: images.width, height: images.height, status: images.status,
          isBest: images.isBest, source: images.source,
          imageTypeSlug: imageTypes.slug,
        })
        .from(images)
        .leftJoin(imageTypes, eq(images.imageTypeId, imageTypes.id))
        .where(inArray(images.skuId, allSkuIds))
    : [];
  const allTags = await db.select().from(tags).where(inArray(tags.productId, pIds));

  const skusByProduct = new Map<string, typeof allSkus>();
  for (const s of allSkus) { const arr = skusByProduct.get(s.productId) || []; arr.push(s); skusByProduct.set(s.productId, arr); }
  const imgsBySku = new Map<string, typeof allImagesRaw>();
  for (const i of allImagesRaw) { const arr = imgsBySku.get(i.skuId) || []; arr.push(i); imgsBySku.set(i.skuId, arr); }
  const tagsByProduct = new Map<string, typeof allTags>();
  for (const t of allTags) { const arr = tagsByProduct.get(t.productId) || []; arr.push(t); tagsByProduct.set(t.productId, arr); }

  // Load warehouse inventory quantities for all SKUs
  const inventoryBySku = new Map<string, number>();
  if (allSkuIds.length > 0) {
    const invStmt = sqlite.prepare(
      `SELECT sku_id, SUM(quantity) as total_qty FROM inventory WHERE location = 'warehouse' GROUP BY sku_id`
    );
    const invRows = invStmt.all() as { sku_id: string; total_qty: number }[];
    for (const row of invRows) {
      inventoryBySku.set(row.sku_id, row.total_qty);
    }
  }

  return allProducts.map((p): ExportProduct => {
    const productSkus = skusByProduct.get(p.id) || [];
    const productImages = productSkus.flatMap((s) => imgsBySku.get(s.id) || []);
    const productTags = tagsByProduct.get(p.id) || [];

    return {
      product: {
        id: p.id, skuPrefix: p.skuPrefix || "", name: p.name, description: p.description,
        shortDescription: p.shortDescription, bulletPoints: p.bulletPoints,
        category: p.category, frameShape: p.frameShape, frameMaterial: p.frameMaterial, gender: p.gender,
      },
      skus: productSkus.map((s) => ({
        id: s.id, sku: s.sku, colorName: s.colorName, colorHex: s.colorHex,
        size: s.size, upc: s.upc, inStock: s.inStock,
        inventoryQuantity: inventoryBySku.get(s.id) ?? 0,
        costPrice: s.costPrice,
      })),
      images: productImages.map((i) => ({
        id: i.id, skuId: i.skuId, filePath: i.filePath, width: i.width,
        height: i.height, status: i.status, isBest: i.isBest,
        source: i.source, imageTypeSlug: i.imageTypeSlug,
      })),
      tags: productTags.map((t) => ({ tagName: t.tagName, dimension: t.dimension })),
      wholesalePrice: p.wholesalePrice, retailPrice: p.retailPrice, msrp: p.msrp,
    };
  });
}
