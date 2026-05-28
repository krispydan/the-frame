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
 */
import { loadExportProducts } from "@/modules/catalog/lib/export/load-products";
import { buildAmazonRows, type AmazonListingInput as MapperListing } from "./column-mapper";
import { getAmazonListings } from "./ai-generate-amazon";
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

export async function composeAmazonRows(productIds?: string[]): Promise<ComposedProduct[]> {
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
