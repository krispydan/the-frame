/**
 * Resolve Shopify retail CDN URLs for a catalog product. Amazon requires
 * absolute HTTPS image URLs for both the spreadsheet's main_image_url
 * column and the AI vision pipeline (Claude needs URLs to fetch from).
 *
 * Strategy: query Shopify retail for a product whose variant SKU starts
 * with our catalog product's skuPrefix, return the ordered list of image
 * src URLs (the hero image first, then galleries). Cached per skuPrefix
 * for a single process run so batch generation doesn't re-hit Shopify
 * for the same product twice.
 *
 * Falls back to whatever we have in catalog_images.url when Shopify
 * doesn't match — the validator will flag if no URL is available at all.
 */
import { getShopifyClientByChannel } from "@/modules/integrations/lib/shopify/admin-api";

interface ShopifyProductImage {
  id: number;
  src: string;
  position: number;
  variant_ids: number[];
}

interface ShopifyVariant {
  id: number;
  sku: string;
  product_id: number;
  image_id: number | null;
}

interface ShopifyProductsListResponse {
  products: Array<{
    id: number;
    title: string;
    handle: string;
    images: ShopifyProductImage[];
    variants: ShopifyVariant[];
  }>;
}

const cache = new Map<string, string[]>();

/**
 * Returns image URLs ordered by Shopify position (hero first). Empty array
 * when no Shopify product is found — caller can fall back or surface an
 * error.
 *
 * Pass-through note: Shopify's CDN URLs (cdn.shopify.com/…) are publicly
 * fetchable, no auth, and they auto-serve the original resolution which
 * satisfies Amazon's 500px minimum for product photos.
 */
export async function getShopifyImageUrls(skuPrefix: string): Promise<string[]> {
  const cached = cache.get(skuPrefix);
  if (cached) return cached;

  try {
    const client = await getShopifyClientByChannel("retail");
    // Shopify products list filtered by SKU prefix is awkward via REST —
    // we use GraphQL with a query filter on the variant's sku field. It
    // returns the parent product when any variant matches.
    const query = `query ($q: String!) {
      products(first: 5, query: $q) {
        edges {
          node {
            id
            title
            featuredImage { url }
            images(first: 20) {
              edges { node { url } }
            }
          }
        }
      }
    }`;
    interface Edge { node: { id: string; title: string; featuredImage: { url: string } | null; images: { edges: Array<{ node: { url: string } }> } } }
    const res = await client.graphql<{ products: { edges: Edge[] } }>(query, {
      q: `sku:${skuPrefix}*`,
    });
    const node = res.products.edges[0]?.node;
    if (!node) {
      cache.set(skuPrefix, []);
      return [];
    }
    const urls: string[] = [];
    const seen = new Set<string>();
    const push = (url: string | null | undefined) => {
      if (!url) return;
      if (seen.has(url)) return;
      seen.add(url);
      urls.push(url);
    };
    push(node.featuredImage?.url);
    for (const e of node.images.edges) push(e.node.url);
    cache.set(skuPrefix, urls);
    return urls;
  } catch (e) {
    console.error(`[amazon/shopify-image-urls] lookup failed for ${skuPrefix}:`, e);
    cache.set(skuPrefix, []);
    return [];
  }
}

/** Tests / dev only — drops the per-process cache. */
export function clearShopifyImageUrlCache(): void {
  cache.clear();
}
