/**
 * Nightly cron handler — syncs Shopify metafields for every product on
 * both stores (dtc + wholesale) using the-frame's tag data as source of truth.
 *
 * Registered in src/modules/integrations/lib/cron/registry.ts.
 * Invoked by the centralized scheduler at /api/v1/cron/tick.
 *
 * This is the catch-all sweep to handle any drift. Immediate syncs
 * are handled by auto-sync.ts on tag mutations (debounced, per-product).
 */

import { db } from "@/lib/db";
import { products, skus as skusTable, tags as tagsTable } from "@/modules/catalog/schema";
import { eq } from "drizzle-orm";
import { syncMetafieldsFromTags } from "./sync-from-tags";
import { syncProductDimensions } from "./dimensions";
import { curatedAttrsFromTags } from "@/modules/catalog/lib/curated-attributes";
import type { ProductForExtendedMetafields } from "./extended-metafields";

const STORES = ["dtc", "wholesale"] as const;

interface StoreSummary {
  ok: number;
  partial: number;
  failed: number;
  failures: string[];
}

export interface BulkSyncResult {
  totalProducts: number;
  /** Index of the last product processed in this call (exclusive). When
   *  paging, the next call should pass offset = processedThrough. */
  processedThrough: number;
  /** How many products this call actually walked (≤ slice limit). */
  processed: number;
  /** Total products remaining after this slice. */
  remaining: number;
  stores: Record<string, StoreSummary>;
  durationMs: number;
}

export interface RunShopifyMetafieldSyncOptions {
  /** Skip this many products from the start of the catalog (sorted by
   *  the default db.select() order). Used to page through the full set
   *  in calls that each stay under Cloudflare's 100s edge timeout. */
  offset?: number;
  /** Cap the number of products processed in this call. Default 8 —
   *  with 2 stores × ~3 Shopify calls per product per store at ~1-2s
   *  each, that puts the worst-case slice around 80s. */
  limit?: number;
}

export async function runShopifyMetafieldSync(
  opts: RunShopifyMetafieldSyncOptions = {},
): Promise<BulkSyncResult> {
  const start = Date.now();
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, Math.min(100, opts.limit ?? 8));
  const allProducts = await db.select().from(products);

  const storeSummary: Record<string, StoreSummary> = {
    dtc: { ok: 0, partial: 0, failed: 0, failures: [] },
    wholesale: { ok: 0, partial: 0, failed: 0, failures: [] },
  };

  const slice = allProducts.slice(offset, offset + limit);
  for (const product of slice) {
    if (!product.skuPrefix) continue;

    const [tagRows, skuRows] = await Promise.all([
      db.select().from(tagsTable).where(eq(tagsTable.productId, product.id)),
      db.select().from(skusTable).where(eq(skusTable.productId, product.id)),
    ]);

    // ── Build the Phase 4 extended-metafields snapshot ──
    // Pure read of curated attrs + style tags + product columns. Same
    // input the SEO builders consume; sync-from-tags appends the
    // resulting metafields to the existing tag-driven payload.
    const curated = curatedAttrsFromTags(
      tagRows.map((t) => ({ dimension: t.dimension ?? "", tagName: t.tagName ?? null })),
    );
    const styleTags = tagRows
      .filter((t) => (t.dimension ?? "").toLowerCase() === "style")
      .map((t) => (t.tagName ?? "").trim())
      .filter(Boolean);
    // Single-dominant-color rule: if every SKU has the same color name,
    // use it; otherwise leave null (the description template skips the
    // color clause for multi-color frames).
    const firstColor = skuRows.length > 0
      ? skuRows[0].colorName ?? null
      : null;
    const allSameColor = firstColor && skuRows.every((s) => s.colorName === firstColor);
    const extended: ProductForExtendedMetafields = {
      productName: product.name ?? product.skuPrefix,
      frameShape: curated.frameShape,
      styleTags,
      gender: curated.gender,
      frameMaterial: curated.frameMaterial,
      frameColor: allSameColor ? firstColor : null,
      lensType: curated.lensType,
      description: product.description,
      collectionBatch: product.collectionBatch,
      retailPrice: product.retailPrice,
      storedSeoTitle: product.seoTitle,
      storedSeoDescription: product.metaDescription,
    };

    for (const store of STORES) {
      try {
        const r = await syncMetafieldsFromTags({
          store,
          skuPrefix: product.skuPrefix,
          tags: tagRows.map((t) => ({ dimension: t.dimension ?? "", tagName: t.tagName ?? null })),
          skuColorNames: skuRows.map((s) => s.colorName),
          extended,
          dryRun: false,
        });

        // Also push the six dimension metafields (custom.lens_width
        // etc.). Previously only the /shopify-push endpoint did this
        // — the nightly cron skipped it, so the dimensions never made
        // it onto products that weren't manually re-pushed. Phase 4
        // brief §1 lists all six as part of the canonical payload.
        if (r.shopifyProductId) {
          try {
            await syncProductDimensions({
              store,
              shopifyProductId: r.shopifyProductId,
              lensWidth: product.lensWidth,
              bridgeWidth: product.bridgeWidth,
              templeLength: product.templeLength,
              lensHeight: product.lensHeight,
              frameWidth: product.frameWidth,
              frameHeight: product.frameHeight ?? null,
            });
          } catch (e) {
            // Non-fatal — log onto the same per-product failure bucket
            // but don't downgrade the category-metafield outcome.
            storeSummary[store].failures.push(
              `${product.skuPrefix} (dimensions): ${e instanceof Error ? e.message : "unknown"}`,
            );
          }
        }

        const summary = storeSummary[store];
        if (r.ok && r.skipReasons.length === 0 && r.metafieldErrors.length === 0) {
          summary.ok++;
        } else if (r.ok) {
          summary.partial++;
        } else {
          summary.failed++;
          summary.failures.push(
            `${product.skuPrefix}: ${r.metafieldErrors.slice(0, 2).join("; ")}`,
          );
        }
      } catch (e) {
        storeSummary[store].failed++;
        storeSummary[store].failures.push(
          `${product.skuPrefix}: ${e instanceof Error ? e.message : "unknown"}`,
        );
      }
    }
  }

  const processedThrough = offset + slice.length;
  return {
    totalProducts: allProducts.length,
    processedThrough,
    processed: slice.length,
    remaining: Math.max(0, allProducts.length - processedThrough),
    stores: storeSummary,
    durationMs: Date.now() - start,
  };
}
