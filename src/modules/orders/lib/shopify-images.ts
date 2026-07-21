/**
 * Shopify image resolver — builds an in-memory map from variant SKU to
 * the Shopify CDN image URL. Used by the PDF catalog generator (and
 * anywhere else that needs a public image URL for a SKU) since the
 * local image pipeline URLs (catalog.jaxyeyewear.com) don't currently
 * resolve.
 *
 * Fetches paginated /products.json from the wholesale store, walks each
 * product's images + variants, and returns a Map<variantSku, imageSrc>.
 *
 * The map is cached in-process for 10 minutes to avoid re-fetching on
 * every PDF generation while still picking up new products / image
 * changes within a reasonable window.
 */
import { shopifyAdminRequest, type ShopifyStore } from "./shopify-api";

interface ShopifyProductWithImages {
  id: number;
  title: string;
  images: Array<{ id: number; src: string; variant_ids: number[] }>;
  variants: Array<{ id: number; sku: string | null; image_id: number | null }>;
}

interface CacheEntry {
  bySku: Map<string, string>;
  bySkuPrefix: Map<string, string[]>; // sku prefix → all image URLs for the product
  fetchedAt: number;
}

const cache = new Map<ShopifyStore, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Fetch all products from a Shopify store with their images + variant mappings.
 * Paginates through /products.json using cursor-based pagination.
 */
async function fetchAllProducts(store: ShopifyStore): Promise<ShopifyProductWithImages[]> {
  const all: ShopifyProductWithImages[] = [];
  let pageInfo: string | null = null;
  const fields = "id,title,images,variants";

  for (let page = 0; page < 20; page++) { // safety cap: 20 × 250 = 5000 products
    const qs = pageInfo
      ? `page_info=${encodeURIComponent(pageInfo)}&limit=250`
      : `limit=250&fields=${fields}`;

    // We use fetch directly here to get access to Link header for pagination
    const cfg = getStoreConfig(store);
    if (!cfg) throw new Error(`Shopify ${store} credentials not configured`);
    const url = `https://${cfg.domain}/admin/api/2024-01/products.json?${qs}`;
    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": cfg.accessToken,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`Shopify ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as { products: ShopifyProductWithImages[] };
    all.push(...(data.products || []));

    // Parse Link header for next page (Shopify cursor-based pagination)
    const link = res.headers.get("link") || res.headers.get("Link") || "";
    const nextMatch = link.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    if (!nextMatch) break;
    pageInfo = decodeURIComponent(nextMatch[1]);
  }

  return all;
}

function getStoreConfig(store: ShopifyStore): { domain: string; accessToken: string } | null {
  const domain = store === "wholesale"
    ? process.env.SHOPIFY_WHOLESALE_STORE_DOMAIN || ""
    : process.env.SHOPIFY_DTC_STORE_DOMAIN || "";
  const accessToken = store === "wholesale"
    ? process.env.SHOPIFY_WHOLESALE_ACCESS_TOKEN || ""
    : process.env.SHOPIFY_DTC_ACCESS_TOKEN || "";
  if (!domain || !accessToken) return null;
  return { domain, accessToken };
}

/**
 * Build (or return cached) SKU → Shopify image URL map for a store.
 */
export async function loadShopifyImageMap(store: ShopifyStore): Promise<CacheEntry> {
  const now = Date.now();
  const cached = cache.get(store);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached;

  const products = await fetchAllProducts(store);
  const bySku = new Map<string, string>();
  const bySkuPrefix = new Map<string, string[]>();

  for (const p of products) {
    // Build image lookup within this product: image_id → src, plus a
    // fallback "first image" for variants without a specific mapping.
    const imgById = new Map<number, string>();
    const variantToImg = new Map<number, string>();
    for (const img of p.images || []) {
      imgById.set(img.id, img.src);
      for (const vid of img.variant_ids || []) {
        if (!variantToImg.has(vid)) variantToImg.set(vid, img.src);
      }
    }
    const firstImage = p.images?.[0]?.src;
    const allProductImages = (p.images || []).map((i) => i.src);

    // Collect SKU prefixes from this product's variants
    const skuPrefixes = new Set<string>();

    for (const v of p.variants || []) {
      if (!v.sku) continue;

      // Prefer variant-specific image, then image_id, then first product image
      const specificImg = variantToImg.get(v.id)
        || (v.image_id ? imgById.get(v.image_id) : undefined)
        || firstImage;

      if (specificImg) bySku.set(v.sku, specificImg);

      // Track SKU prefix (everything up to the last "-")
      const dash = v.sku.lastIndexOf("-");
      if (dash > 0) skuPrefixes.add(v.sku.slice(0, dash));
    }

    // Store all product images against every SKU prefix on the product
    for (const prefix of skuPrefixes) {
      bySkuPrefix.set(prefix, allProductImages);
    }
  }

  const entry: CacheEntry = { bySku, bySkuPrefix, fetchedAt: now };
  cache.set(store, entry);
  return entry;
}

/**
 * Look up a Shopify image URL for a single variant SKU. Returns null on miss.
 */
export async function getShopifyImageForSku(
  store: ShopifyStore,
  sku: string | null | undefined,
): Promise<string | null> {
  if (!sku) return null;
  try {
    const map = await loadShopifyImageMap(store);
    // Direct SKU match first
    const direct = map.bySku.get(sku);
    if (direct) return direct;
    // Fall back to the product's first image (matched via SKU prefix)
    const dash = sku.lastIndexOf("-");
    if (dash > 0) {
      const prefix = sku.slice(0, dash);
      const productImages = map.bySkuPrefix.get(prefix);
      if (productImages && productImages.length > 0) return productImages[0];
    }
    return null;
  } catch (e) {
    console.warn(`[shopify-images] lookup failed for ${sku}:`, e);
    return null;
  }
}

export interface MultiStoreLookupStats {
  configured: boolean;
  domain: string | null;
  totalVariantsInShopify: number;
  totalProductsInShopify: number;
  matched: number;
  matchedByPrefix: number;
  error: string | null;
  sampleShopifySkus: string[]; // first 10 SKUs on the store — useful for format-mismatch diagnosis
}

/**
 * Batch-resolve images for many SKUs across multiple stores. Tries each store
 * in order — the first store that has an image for a given SKU wins. Useful
 * when products live on the retail store but not (yet) on wholesale.
 *
 * Returns per-store stats including whether credentials are configured, any
 * error encountered, and a sample of the actual SKUs on that store (so a
 * caller can see if there's a SKU format mismatch).
 */
export async function getShopifyImagesForSkusMultiStore(
  stores: ShopifyStore[],
  skus: Array<string | null | undefined>,
): Promise<{ images: Map<string, string>; stats: Record<string, MultiStoreLookupStats> }> {
  const images = new Map<string, string>();
  const stats: Record<string, MultiStoreLookupStats> = {};
  const remaining = new Set(skus.filter((s): s is string => Boolean(s)));

  for (const store of stores) {
    const cfg = getStoreConfig(store);
    stats[store] = {
      configured: !!cfg,
      domain: cfg?.domain || null,
      totalVariantsInShopify: 0,
      totalProductsInShopify: 0,
      matched: 0,
      matchedByPrefix: 0,
      error: null,
      sampleShopifySkus: [],
    };

    if (!cfg) {
      stats[store].error = `Missing SHOPIFY_${store.toUpperCase()}_STORE_DOMAIN or SHOPIFY_${store.toUpperCase()}_ACCESS_TOKEN env var`;
      continue;
    }

    let map: CacheEntry;
    try {
      map = await loadShopifyImageMap(store);
    } catch (e) {
      stats[store].error = String(e);
      console.warn(`[shopify-images] load failed for ${store}:`, e);
      continue;
    }
    stats[store].totalVariantsInShopify = map.bySku.size;
    stats[store].totalProductsInShopify = map.bySkuPrefix.size;
    stats[store].sampleShopifySkus = Array.from(map.bySku.keys()).slice(0, 10);

    for (const sku of Array.from(remaining)) {
      const direct = map.bySku.get(sku);
      if (direct) {
        images.set(sku, direct);
        stats[store].matched++;
        remaining.delete(sku);
        continue;
      }
      const dash = sku.lastIndexOf("-");
      if (dash > 0) {
        const prefix = sku.slice(0, dash);
        const productImages = map.bySkuPrefix.get(prefix);
        if (productImages && productImages.length > 0) {
          images.set(sku, productImages[0]);
          stats[store].matched++;
          stats[store].matchedByPrefix++;
          remaining.delete(sku);
        }
      }
    }
  }

  return { images, stats };
}

/**
 * Batch-resolve images for many SKUs at once (single store). More efficient
 * than calling getShopifyImageForSku in a loop because the cache load is amortized.
 */
export async function getShopifyImagesForSkus(
  store: ShopifyStore,
  skus: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const map = await loadShopifyImageMap(store);
  for (const sku of skus) {
    if (!sku) continue;
    const direct = map.bySku.get(sku);
    if (direct) {
      result.set(sku, direct);
      continue;
    }
    const dash = sku.lastIndexOf("-");
    if (dash > 0) {
      const prefix = sku.slice(0, dash);
      const productImages = map.bySkuPrefix.get(prefix);
      if (productImages && productImages.length > 0) {
        result.set(sku, productImages[0]);
      }
    }
  }
  return result;
}

/** Clear the in-process cache. Exposed for admin / testing. */
export function clearShopifyImageCache(store?: ShopifyStore): void {
  if (store) cache.delete(store);
  else cache.clear();
}

// Suppress unused import warning; shopifyAdminRequest is exported for other files
void shopifyAdminRequest;
