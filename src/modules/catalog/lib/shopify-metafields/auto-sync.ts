/**
 * Auto-sync product metafields to Shopify whenever its tags change.
 *
 * Strategy: fire-and-forget, debounced per product. The user clicks
 * "add tag" → "remove tag" → "add tag" rapidly; we collapse those into
 * a single sync ~2s after the last change. Both stores in parallel.
 *
 * Errors are logged but never thrown — the calling tag mutation has
 * already succeeded and we don't want to break the user's edit flow if
 * Shopify is unavailable. If you need guaranteed delivery, push this
 * onto the centralized cron queue instead.
 */
import { db } from "@/lib/db";
import { products, skus as skusTable, tags as tagsTable } from "@/modules/catalog/schema";
import { eq } from "drizzle-orm";
import {
  hasShopifyCredentials,
  type ShopifyStore,
} from "@/modules/orders/lib/shopify-api";
import { syncMetafieldsFromTags } from "./sync-from-tags";

/** Pending debounce timers, keyed by productId. */
const pendingByProduct = new Map<string, NodeJS.Timeout>();

/** How long we wait after the last tag change before pushing. */
const DEBOUNCE_MS = 2_000;

/** Stores we sync to whenever tags change. */
const STORES: ShopifyStore[] = ["dtc", "wholesale"];

/**
 * Schedule a Shopify metafield sync for this product. Idempotent; rapid
 * successive calls collapse into a single sync 2s after the last call.
 *
 * Call this from any endpoint that mutates a product's tag rows.
 */
export function scheduleShopifyTagSync(productId: string): void {
  if (!productId) return;

  const existing = pendingByProduct.get(productId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingByProduct.delete(productId);
    runSync(productId).catch((err) => {
      console.error(`[shopify auto-sync] ${productId}:`, err instanceof Error ? err.message : err);
    });
  }, DEBOUNCE_MS);

  // Allow the Node process to exit if the timer is the only thing keeping it alive.
  if (typeof timer.unref === "function") timer.unref();

  pendingByProduct.set(productId, timer);
}

async function runSync(productId: string): Promise<void> {
  const product = (await db.select().from(products).where(eq(products.id, productId)))[0];
  if (!product || !product.skuPrefix) {
    console.warn(`[shopify auto-sync] product ${productId} not found or has no SKU prefix`);
    return;
  }

  const tagRows = await db.select().from(tagsTable).where(eq(tagsTable.productId, productId));
  const skuRows = await db
    .select({ colorName: skusTable.colorName })
    .from(skusTable)
    .where(eq(skusTable.productId, productId));

  for (const store of STORES) {
    const ok = await hasShopifyCredentials(store);
    if (!ok) continue;
    try {
      const r = await syncMetafieldsFromTags({
        store,
        skuPrefix: product.skuPrefix,
        tags: tagRows.map((t) => ({ dimension: t.dimension ?? "", tagName: t.tagName ?? null })),
        skuColorNames: skuRows.map((s) => s.colorName),
      });
      const summary = r.ok
        ? `wrote ${r.metafieldsWritten}/${r.metafieldsAttempted}`
        : `FAILED ${r.metafieldErrors.join("; ")}`;
      console.log(
        `[shopify auto-sync] ${product.skuPrefix} ${store}: ${summary}` +
          (r.skipReasons.length > 0 ? ` (${r.skipReasons.length} skipped)` : ""),
      );
    } catch (err) {
      console.error(
        `[shopify auto-sync] ${product.skuPrefix} ${store} threw:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
