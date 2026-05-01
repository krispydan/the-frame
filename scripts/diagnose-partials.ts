/**
 * Identify exactly which metaobject handles are missing on each store,
 * across all products. Gives the user a precise seed list per store.
 *
 * Run: npx tsx scripts/diagnose-partials.ts
 */
import { db } from "@/lib/db";
import { products, skus as skusTable, tags as tagsTable } from "@/modules/catalog/schema";
import { eq } from "drizzle-orm";
import { syncMetafieldsFromTags } from "@/modules/catalog/lib/shopify-metafields/sync-from-tags";

async function main() {
  const allProducts = await db.select().from(products);

  // Track per-store, per-metaobject-type which handles are missing
  // and which products would benefit from each.
  const missing: Record<"dtc" | "wholesale", Map<string, Map<string, string[]>>> = {
    dtc: new Map(),
    wholesale: new Map(),
  };

  for (const product of allProducts) {
    if (!product.skuPrefix) continue;
    const tagRows = await db.select().from(tagsTable).where(eq(tagsTable.productId, product.id));
    const skuRows = await db
      .select({ colorName: skusTable.colorName })
      .from(skusTable)
      .where(eq(skusTable.productId, product.id));

    for (const store of ["dtc", "wholesale"] as const) {
      const r = await syncMetafieldsFromTags({
        store,
        skuPrefix: product.skuPrefix,
        tags: tagRows.map((t) => ({ dimension: t.dimension ?? "", tagName: t.tagName ?? null })),
        skuColorNames: skuRows.map((s) => s.colorName),
        dryRun: true,
      });

      for (const skip of r.skipReasons) {
        // skip.reason looks like: "Shopify metaobject not found on dtc (tried: <handle>, <fallback>)"
        const m = skip.reason.match(/tried: ([^)]+)\)/);
        const handlesTried = m ? m[1].split(",").map((s) => s.trim()) : [];
        const fieldType = skip.field; // e.g. "lens-polarization", "color-pattern"
        if (!missing[store].has(fieldType)) missing[store].set(fieldType, new Map());
        const byHandle = missing[store].get(fieldType)!;
        const handle = handlesTried[0] ?? skip.reason;
        if (!byHandle.has(handle)) byHandle.set(handle, []);
        byHandle.get(handle)!.push(product.skuPrefix);
      }
    }
  }

  for (const store of ["dtc", "wholesale"] as const) {
    console.log(`\n══════════════════════════════════════════════`);
    console.log(`  ${store.toUpperCase()} — handles to seed`);
    console.log(`══════════════════════════════════════════════`);
    if (missing[store].size === 0) {
      console.log(`  Nothing missing — fully synced.`);
      continue;
    }
    for (const [field, byHandle] of missing[store]) {
      console.log(`\n  ${field}:`);
      const entries = [...byHandle.entries()].sort((a, b) => b[1].length - a[1].length);
      for (const [handle, skus] of entries) {
        console.log(`    "${handle}"  affects ${skus.length} products: ${skus.join(", ")}`);
      }
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
