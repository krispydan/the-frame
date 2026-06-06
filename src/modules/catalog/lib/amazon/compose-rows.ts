/**
 * End-to-end row composer for the Amazon export. Walks a set of products,
 * loads their persisted catalog_amazon_listings row (when present),
 * fetches Shopify CDN image URLs, and calls buildAmazonRows to produce
 * the parent + child Record<attr,string>[] tuple per product.
 *
 * Used by:
 *   - /api/v1/integrations/amazon/download — turns rows into the XLSX,
 *   - /api/v1/integrations/amazon/validate — feeds the same rows into
 *     the validator without writing a file.
 *
 * Both endpoints share this so we never validate one row-set and ship a
 * different one.
 *
 * Mode selection (Phase 4 of group-restructure plan):
 *   - When the catalog has rows in catalog_amazon_listing_groups AND
 *     all products carry an amazon_group_key → ship the GROUPED feed
 *     (one parent per shape, children labeled "<Style> - <Color>").
 *   - Otherwise → ship the legacy PER-PRODUCT feed (one parent per
 *     style, color-only children). This keeps the rollback path open
 *     without code changes.
 */
import { loadExportProducts } from "@/modules/catalog/lib/export/load-products";
import { db } from "@/lib/db";
import { products as productsTable } from "@/modules/catalog/schema";
import { inArray } from "drizzle-orm";
import {
  buildAmazonRows,
  buildAmazonGroupRows,
  type AmazonListingInput as MapperListing,
  type AmazonGroupListing,
} from "./column-mapper";
import {
  getAmazonListings,
  getAmazonGroupListing,
  listAmazonGroupKeys,
} from "./ai-generate-amazon";
import { getShopifyImageUrls } from "./shopify-image-urls";

export interface ComposedProduct {
  productId: string;
  productName: string;
  skuPrefix: string;
  rows: Record<string, string>[];
  skuIdentifiers: Array<{ skuId: string; sku: string }>;
  /** Whether catalog_amazon_listings had a row for this product. */
  hasListing: boolean;
  /** Whether Shopify returned any image URLs. */
  hasImages: boolean;
}

/**
 * Compose Amazon rows in GROUPED mode (Phase 4). Returns one
 * ComposedProduct per group — caller treats each as a self-contained
 * row block. skuIdentifiers track every child in the group for
 * validator attribution.
 *
 * Returns an empty array if no group listings exist yet — caller
 * should fall back to composeAmazonRows().
 */
export async function composeAmazonGroupRows(): Promise<ComposedProduct[]> {
  const groups = await listAmazonGroupKeys();
  if (groups.length === 0) return [];

  const out: ComposedProduct[] = [];

  for (const { groupKey } of groups) {
    const groupListing = await getAmazonGroupListing(groupKey);
    if (!groupListing) {
      // No persisted group listing yet — skip; caller falls back to
      // per-product mode if every group is missing.
      continue;
    }

    // Pull every product in the group (ordered by sku_prefix —
    // matches the orchestrator's "first product is representative"
    // rule so parent image is deterministic).
    const groupProducts = await db
      .select()
      .from(productsTable)
      .where(inArray(productsTable.amazonGroupKey, [groupKey]));
    if (groupProducts.length === 0) continue;
    groupProducts.sort((a, b) => (a.skuPrefix ?? "").localeCompare(b.skuPrefix ?? ""));

    const productIds = groupProducts.map((p) => p.id);
    const exportProducts = await loadExportProducts(productIds);
    if (exportProducts.length === 0) continue;
    // Re-sort exportProducts to match the order we want (sku_prefix ASC).
    exportProducts.sort((a, b) => (a.product.skuPrefix ?? "").localeCompare(b.product.skuPrefix ?? ""));

    // Bulk-fetch image URLs for every product in the group.
    const imageUrlsByProductId = new Map<string, string[]>();
    for (const ep of exportProducts) {
      const urls = ep.product.skuPrefix ? await getShopifyImageUrls(ep.product.skuPrefix) : [];
      imageUrlsByProductId.set(ep.product.id, urls);
    }

    const groupSnapshot: AmazonGroupListing = {
      groupKey: groupListing.groupKey,
      shape: groupListing.shape,
      title: groupListing.title,
      productDescription: groupListing.productDescription,
      bulletPoint1: groupListing.bulletPoint1,
      bulletPoint2: groupListing.bulletPoint2,
      bulletPoint3: groupListing.bulletPoint3,
      bulletPoint4: groupListing.bulletPoint4,
      bulletPoint5: groupListing.bulletPoint5,
      genericKeywords: groupListing.genericKeywords,
      suggestedFrameMaterial: null,  // group-level not stored; column-mapper falls back
      suggestedPolarization: null,
    };

    const rows = buildAmazonGroupRows({
      group: groupSnapshot,
      products: exportProducts,
      imageUrlsByProductId,
    });

    // Build skuIdentifiers parallel to children — every (product ×
    // sku × {FBM, FBA}) gets one entry. Matches the order
    // buildAmazonGroupRows emits children in.
    const skuIdentifiers: Array<{ skuId: string; sku: string }> = [];
    for (const ep of exportProducts) {
      for (const sku of ep.skus) {
        const base = sku.sku ?? "";
        skuIdentifiers.push({ skuId: sku.id, sku: base });
        skuIdentifiers.push({ skuId: sku.id, sku: base ? `${base}-FBA` : "" });
      }
    }

    const allImages = Array.from(imageUrlsByProductId.values()).flat();
    out.push({
      productId: groupListing.id,
      productName: groupListing.displayName,
      skuPrefix: `JAXY-GROUP-${groupKey.toUpperCase()}`,
      rows,
      skuIdentifiers,
      hasListing: true,
      hasImages: allImages.length > 0,
    });
  }

  return out;
}

export async function composeAmazonRows(productIds?: string[]): Promise<ComposedProduct[]> {
  // Phase 4 mode preference: if any group listings exist AND the
  // caller didn't pass a productIds whitelist, ship the grouped feed.
  // The whitelist case is reserved for the per-product validate UI
  // which still wants single-product previews.
  if (!productIds || productIds.length === 0) {
    const grouped = await composeAmazonGroupRows();
    if (grouped.length > 0) return grouped;
  }

  const exportProducts = await loadExportProducts(productIds);
  if (exportProducts.length === 0) return [];

  const listingMap = await getAmazonListings(exportProducts.map((p) => p.product.id));
  const out: ComposedProduct[] = [];

  for (const ep of exportProducts) {
    const listingRow = listingMap.get(ep.product.id);
    const listing: MapperListing | null = listingRow
      ? {
          amazonTitle: listingRow.amazonTitle,
          bulletPoint1: listingRow.bulletPoint1,
          bulletPoint2: listingRow.bulletPoint2,
          bulletPoint3: listingRow.bulletPoint3,
          bulletPoint4: listingRow.bulletPoint4,
          bulletPoint5: listingRow.bulletPoint5,
          productDescription: listingRow.productDescription,
          genericKeywords: listingRow.genericKeywords,
          suggestedColorMap: listingRow.suggestedColorMap,
          suggestedLensMaterial: listingRow.suggestedLensMaterial,
          suggestedFrameMaterial: listingRow.suggestedFrameMaterial,
          suggestedPolarization: listingRow.suggestedPolarization,
          suggestedItemShape: listingRow.suggestedItemShape,
        }
      : null;

    const imageUrls = await getShopifyImageUrls(ep.product.skuPrefix);
    const rows = buildAmazonRows({ product: ep, listing, imageUrls });

    out.push({
      productId: ep.product.id,
      productName: ep.product.name ?? ep.product.skuPrefix,
      skuPrefix: ep.product.skuPrefix,
      rows,
      // Two child rows per catalog SKU (FBM + FBA — see column-mapper.ts);
      // the validator attributes child-row issues by index into this
      // array, so we flatMap to keep it 1:1 with the rows.
      skuIdentifiers: ep.skus.flatMap((s) => {
        const base = s.sku ?? "";
        return [
          { skuId: s.id, sku: base },
          { skuId: s.id, sku: base ? `${base}-FBA` : "" },
        ];
      }),
      hasListing: !!listingRow,
      hasImages: imageUrls.length > 0,
    });
  }
  return out;
}
