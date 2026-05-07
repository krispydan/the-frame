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

const STORES = ["dtc", "wholesale"] as const;

interface StoreSummary {
  ok: number;
  partial: number;
  failed: number;
  failures: string[];
}

export interface BulkSyncResult {
  totalProducts: number;
  stores: Record<string, StoreSummary>;
  durationMs: number;
}

export async function runShopifyMetafieldSync(): Promise<BulkSyncResult> {
  const start = Date.now();
  const allProducts = await db.select().from(products);

  const storeSummary: Record<string, StoreSummary> = {
    dtc: { ok: 0, partial: 0, failed: 0, failures: [] },
    wholesale: { ok: 0, partial: 0, failed: 0, failures: [] },
  };

  for (const product of allProducts) {
    if (!product.skuPrefix) continue;

    const [tagRows, skuRows] = await Promise.all([
      db.select().from(tagsTable).where(eq(tagsTable.productId, product.id)),
      db.select({ colorName: skusTable.colorName }).from(skusTable).where(eq(skusTable.productId, product.id)),
    ]);

    for (const store of STORES) {
      try {
        const r = await syncMetafieldsFromTags({
          store,
          skuPrefix: product.skuPrefix,
          tags: tagRows.map((t) => ({ dimension: t.dimension ?? "", tagName: t.tagName ?? null })),
          skuColorNames: skuRows.map((s) => s.colorName),
          dryRun: false,
        });

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

  return {
    totalProducts: allProducts.length,
    stores: storeSummary,
    durationMs: Date.now() - start,
  };
}
