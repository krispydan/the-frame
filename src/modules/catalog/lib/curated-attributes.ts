/**
 * Curated product attributes — single source of truth derived from
 * `catalog_tags`. Replaces the legacy single-value columns
 * `frame_shape`, `frame_material`, `lens_type`, `gender`, `category`
 * on the products table.
 *
 * Why: users curate tags on the Tags tab; the legacy columns were a
 * separate edit surface that drifted out of sync. Now anything that
 * needs "the frame shape" reads it from tags via this module.
 *
 * Multi-value tag dimensions (e.g. a product with both gender=male AND
 * gender=female) collapse to a representative single value here for
 * compatibility with consumers that expect scalars (PDF export, copy
 * templates, etc.). Multi-value-aware code paths (e.g. Shopify
 * metafield sync) should keep reading the raw tag rows.
 */
import { db } from "@/lib/db";
import { tags as tagsTable } from "@/modules/catalog/schema";
import { eq, inArray } from "drizzle-orm";

/** What used to live on `catalog_products` as columns. */
export interface CuratedAttrs {
  category: "sunglasses" | "optical" | "reading" | null;
  frameShape: string | null;
  frameMaterial: string | null;
  gender: string | null;
  lensType: string | null;
}

/** Tag rows we accept (subset of the catalog_tags row). */
export type TagRow = { dimension: string | null; tagName: string | null };

/** Lowercase trim. */
const norm = (s: string | null | undefined): string =>
  (s ?? "").trim().toLowerCase();

/** Pick the first non-empty tag value whose dimension matches one of `dims`. */
function pickFirst(rows: TagRow[], dims: string[]): string | null {
  for (const r of rows) {
    if (!dims.includes(norm(r.dimension))) continue;
    const val = (r.tagName ?? "").trim();
    if (val) return val;
  }
  return null;
}

/**
 * Pure: given the tag rows for a product, derive the 5 curated attributes.
 * Use this when you already loaded tags. Otherwise call
 * {@link getCuratedAttrs}.
 */
export function curatedAttrsFromTags(rows: TagRow[]): CuratedAttrs {
  const category = pickFirst(rows, ["category", "producttype", "product_type"]);
  return {
    category:
      category === "sunglasses" || category === "optical" || category === "reading"
        ? category
        : null,
    frameShape: pickFirst(rows, ["frameshape", "frame_shape"]),
    frameMaterial: pickFirst(rows, [
      "framematerial",
      "frame_material",
      "materialframe",
      "material",
    ]),
    gender: pickFirst(rows, ["gender"]),
    lensType: pickFirst(rows, ["lens", "lenstype", "lens_type"]),
  };
}

/** Async: fetch this product's tags and return derived attrs. */
export async function getCuratedAttrs(productId: string): Promise<CuratedAttrs> {
  const rows = await db
    .select({ dimension: tagsTable.dimension, tagName: tagsTable.tagName })
    .from(tagsTable)
    .where(eq(tagsTable.productId, productId));
  return curatedAttrsFromTags(rows);
}

/**
 * Async + batched: derive attrs for many products in one round-trip.
 * Returns a map keyed by productId.
 */
export async function getCuratedAttrsForProducts(
  productIds: string[],
): Promise<Map<string, CuratedAttrs>> {
  const out = new Map<string, CuratedAttrs>();
  if (productIds.length === 0) return out;
  const rows = await db
    .select({
      productId: tagsTable.productId,
      dimension: tagsTable.dimension,
      tagName: tagsTable.tagName,
    })
    .from(tagsTable)
    .where(inArray(tagsTable.productId, productIds));
  const byProduct = new Map<string, TagRow[]>();
  for (const r of rows) {
    if (!r.productId) continue;
    if (!byProduct.has(r.productId)) byProduct.set(r.productId, []);
    byProduct.get(r.productId)!.push({ dimension: r.dimension, tagName: r.tagName });
  }
  for (const id of productIds) {
    out.set(id, curatedAttrsFromTags(byProduct.get(id) ?? []));
  }
  return out;
}

/**
 * Overlay curated attrs onto a product row. The shape returned exactly
 * matches the legacy product type (so downstream consumers continue to
 * read `.frameShape` etc. with no changes), but the values come from
 * tags rather than the dropped columns.
 */
export async function enrichProductWithCurated<T extends { id: string }>(
  product: T,
): Promise<T & CuratedAttrs> {
  const attrs = await getCuratedAttrs(product.id);
  return { ...product, ...attrs };
}

/** Batched version of {@link enrichProductWithCurated}. */
export async function enrichProductsWithCurated<T extends { id: string }>(
  products: T[],
): Promise<Array<T & CuratedAttrs>> {
  const map = await getCuratedAttrsForProducts(products.map((p) => p.id));
  return products.map((p) => ({ ...p, ...(map.get(p.id) ?? curatedAttrsFromTags([])) }));
}
