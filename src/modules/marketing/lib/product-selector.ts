/**
 * Product selector for marketing-email campaigns.
 *
 * Some campaigns feature real products. This module pulls a compact,
 * AI-ready summary of products from the catalog — name, description,
 * specs (from curated tags + frame dimensions), price, and the best
 * product image URL — so the copy + image-brief generators can ground
 * an email in an actual SKU rather than generic brand voice.
 *
 * Two entry points:
 *   - resolveProducts(ids)  → summaries for a campaign's featured ids
 *   - getProductPickList()  → candidates for the editor picker /
 *                             planner auto-suggest (top sellers / in stock)
 */
import { db } from "@/lib/db";
import { products, skus, images, tags } from "@/modules/catalog/schema";
import { orderItems } from "@/modules/orders/schema";
import { catalogImageUrl } from "@/lib/storage/image-url";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

export interface ProductSummary {
  id: string;
  name: string;
  description: string;
  /** Short human-readable spec lines, e.g. "frame shape: round", "Lens 51mm · Bridge 22mm · Temple 145mm". */
  specs: string[];
  priceRetail: number | null;
  priceWholesale: number | null;
  /** Best product image as a full URL (null if the product has no image yet). */
  imageUrl: string | null;
  imageAlt: string | null;
}

/** Products that are real enough to feature: published/approved + named. */
const FEATURABLE_STATUSES = ["approved", "published"] as const;

function cleanDescription(p: { description: string | null; shortDescription: string | null }): string {
  const raw = (p.shortDescription || p.description || "").trim();
  // Collapse whitespace; cap length so the prompt stays lean.
  return raw.replace(/\s+/g, " ").slice(0, 400);
}

async function specsFor(productId: string, frame: {
  lensWidth: number | null; bridgeWidth: number | null; templeLength: number | null; frameSize: string | null;
}): Promise<string[]> {
  const rows = await db
    .select({ dimension: tags.dimension, tagName: tags.tagName })
    .from(tags)
    .where(eq(tags.productId, productId));

  const out: string[] = [];
  // Curated tag dimensions first (frame shape/material/lens type/gender…).
  for (const r of rows) {
    if (r.dimension && r.tagName) out.push(`${r.dimension.replace(/_/g, " ")}: ${r.tagName}`);
    else if (r.tagName) out.push(r.tagName);
  }
  // Frame measurements, if present.
  if (frame.lensWidth && frame.bridgeWidth && frame.templeLength) {
    out.push(`Lens ${frame.lensWidth}mm · Bridge ${frame.bridgeWidth}mm · Temple ${frame.templeLength}mm`);
  } else if (frame.frameSize) {
    out.push(`Frame size: ${frame.frameSize}`);
  }
  return out.slice(0, 8);
}

async function bestImage(productId: string): Promise<{ url: string | null; alt: string | null }> {
  const [img] = await db
    .select({ filePath: images.filePath, url: images.url, alt: images.altText })
    .from(images)
    .innerJoin(skus, eq(images.skuId, skus.id))
    .where(eq(skus.productId, productId))
    .orderBy(desc(images.isBest), asc(images.position))
    .limit(1);
  if (!img) return { url: null, alt: null };
  return { url: catalogImageUrl(img.filePath) ?? img.url ?? null, alt: img.alt ?? null };
}

async function toSummaries(
  rows: Array<{
    id: string; name: string | null; description: string | null; shortDescription: string | null;
    retailPrice: number | null; wholesalePrice: number | null;
    lensWidth: number | null; bridgeWidth: number | null; templeLength: number | null; frameSize: string | null;
  }>,
): Promise<ProductSummary[]> {
  const out: ProductSummary[] = [];
  for (const p of rows) {
    if (!p.name) continue;
    const [specs, image] = await Promise.all([
      specsFor(p.id, p),
      bestImage(p.id),
    ]);
    out.push({
      id: p.id,
      name: p.name,
      description: cleanDescription(p),
      specs,
      priceRetail: p.retailPrice,
      priceWholesale: p.wholesalePrice,
      imageUrl: image.url,
      imageAlt: image.alt,
    });
  }
  return out;
}

const PRODUCT_COLS = {
  id: products.id,
  name: products.name,
  description: products.description,
  shortDescription: products.shortDescription,
  retailPrice: products.retailPrice,
  wholesalePrice: products.wholesalePrice,
  lensWidth: products.lensWidth,
  bridgeWidth: products.bridgeWidth,
  templeLength: products.templeLength,
  frameSize: products.frameSize,
};

/**
 * Resolve specific product ids (a campaign's featured_product_ids) into
 * AI-ready summaries. Preserves the caller's id order; silently drops
 * ids that no longer exist.
 */
export async function resolveProducts(ids: string[]): Promise<ProductSummary[]> {
  const clean = ids.filter(Boolean);
  if (clean.length === 0) return [];
  const rows = await db.select(PRODUCT_COLS).from(products).where(inArray(products.id, clean));
  const summaries = await toSummaries(rows);
  // Restore requested order.
  const byId = new Map(summaries.map((s) => [s.id, s]));
  return clean.map((id) => byId.get(id)).filter((s): s is ProductSummary => !!s);
}

/** Free-text search over product name + sku prefix (featurable only). */
export async function searchProducts(q: string, limit = 12): Promise<ProductSummary[]> {
  const term = q.trim();
  if (!term) return [];
  const like = `%${term.replace(/[%_]/g, (m) => "\\" + m)}%`;
  const rows = await db
    .select(PRODUCT_COLS)
    .from(products)
    .where(
      and(
        inArray(products.status, [...FEATURABLE_STATUSES]),
        sql`(${products.name} LIKE ${like} ESCAPE '\\' OR ${products.skuPrefix} LIKE ${like} ESCAPE '\\')`,
      ),
    )
    .limit(Math.min(Math.max(limit, 1), 50));
  return toSummaries(rows);
}

export type PickMode = "top_sellers" | "in_stock";

/**
 * Candidate products for the editor picker + planner auto-suggest.
 *   top_sellers — most-ordered products (by order_items quantity)
 *   in_stock    — products with at least one in-stock SKU
 * Both are restricted to featurable (approved/published, named) products.
 */
export async function getProductPickList(opts: { mode: PickMode; limit?: number }): Promise<ProductSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 12, 1), 50);

  if (opts.mode === "top_sellers") {
    const ranked = await db
      .select({ productId: orderItems.productId, qty: sql<number>`sum(${orderItems.quantity})` })
      .from(orderItems)
      .where(isNotNull(orderItems.productId))
      .groupBy(orderItems.productId)
      .orderBy(desc(sql`sum(${orderItems.quantity})`))
      .limit(limit * 2); // over-fetch; some may be unfeaturable
    const ids = ranked.map((r) => r.productId).filter((x): x is string => !!x);
    if (ids.length === 0) return [];
    const rows = await db
      .select(PRODUCT_COLS)
      .from(products)
      .where(and(inArray(products.id, ids), inArray(products.status, [...FEATURABLE_STATUSES])));
    const summaries = await toSummaries(rows);
    const byId = new Map(summaries.map((s) => [s.id, s]));
    return ids.map((id) => byId.get(id)).filter((s): s is ProductSummary => !!s).slice(0, limit);
  }

  // in_stock
  const rows = await db
    .selectDistinct(PRODUCT_COLS)
    .from(products)
    .innerJoin(skus, eq(skus.productId, products.id))
    .where(and(eq(skus.inStock, true), inArray(products.status, [...FEATURABLE_STATUSES])))
    .limit(limit);
  return toSummaries(rows);
}

/**
 * Pick `n` random featurable products for auto-suggestion (planner) or
 * the editor's "surprise me" button. Pulls a candidate pool then shuffles.
 */
export async function suggestRandomProducts(n: number, mode: PickMode = "in_stock"): Promise<ProductSummary[]> {
  const pool = await getProductPickList({ mode, limit: 50 });
  // Fisher–Yates on a copy (runtime randomness is fine here — this is
  // app code, not a deterministic workflow).
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(0, n));
}

/**
 * Render a list of product summaries into a compact text block for the
 * AI prompt. Kept here so copy + image-brief generators format products
 * identically.
 */
export function formatProductsForPrompt(items: ProductSummary[]): string {
  if (items.length === 0) return "";
  return items
    .map((p, i) => {
      const price =
        p.priceRetail != null ? `$${p.priceRetail.toFixed(2)} retail` : p.priceWholesale != null ? `$${p.priceWholesale.toFixed(2)} wholesale` : "";
      const lines = [
        `${i + 1}. ${p.name}${price ? ` (${price})` : ""}`,
        p.description ? `   ${p.description}` : "",
        p.specs.length ? `   Specs: ${p.specs.join(" · ")}` : "",
        p.imageUrl ? `   Image: ${p.imageUrl}` : "",
      ];
      return lines.filter(Boolean).join("\n");
    })
    .join("\n\n");
}
