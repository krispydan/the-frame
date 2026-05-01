/**
 * Run the tag→metafield sync against one or more SKU prefixes on both stores.
 * Defaults to dry-run; pass --live to actually write.
 *
 * Usage:
 *   npx tsx scripts/test-sync-jx1001.ts                # dry, JX1001
 *   npx tsx scripts/test-sync-jx1001.ts JX1001 JX1002  # dry, both
 *   npx tsx scripts/test-sync-jx1001.ts --live JX1001 JX1002
 */
import { db } from "@/lib/db";
import { products, skus as skusTable, tags as tagsTable } from "@/modules/catalog/schema";
import { eq } from "drizzle-orm";
import { syncMetafieldsFromTags } from "@/modules/catalog/lib/shopify-metafields/sync-from-tags";

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const skuPrefixes = args.filter((a) => !a.startsWith("--"));
  const targets = skuPrefixes.length > 0 ? skuPrefixes : ["JX1001"];

  console.log(`Mode: ${live ? "LIVE" : "DRY RUN"}`);
  console.log(`Targets: ${targets.join(", ")}\n`);

  for (const skuPrefix of targets) {
    console.log(`══════════════════════════════════════════════`);
    console.log(`  ${skuPrefix}`);
    console.log(`══════════════════════════════════════════════`);

    const product = (await db.select().from(products).where(eq(products.skuPrefix, skuPrefix)))[0];
    if (!product) {
      console.error(`  No product with skuPrefix=${skuPrefix} — skipping`);
      continue;
    }
    const tagRows = await db.select().from(tagsTable).where(eq(tagsTable.productId, product.id));
    const skuRows = await db
      .select({ colorName: skusTable.colorName })
      .from(skusTable)
      .where(eq(skusTable.productId, product.id));

    console.log(`  ${product.name}  (${tagRows.length} tags, ${skuRows.length} SKUs)`);

    for (const store of ["dtc", "wholesale"] as const) {
      console.log(`\n  ── ${store.toUpperCase()} ──`);
      try {
        const r = await syncMetafieldsFromTags({
          store,
          skuPrefix: product.skuPrefix!,
          tags: tagRows.map((t) => ({ dimension: t.dimension ?? "", tagName: t.tagName ?? null })),
          skuColorNames: skuRows.map((s) => s.colorName),
          dryRun: !live,
        });
        console.log(
          `  ok=${r.ok}  attempted=${r.metafieldsAttempted}  written=${r.metafieldsWritten}  shopifyId=${r.shopifyProductId}`,
        );
        for (const f of r.resolved) {
          console.log(`    ✓ ${f.field}: "${f.handle}" ${f.gid ? `→ ${f.gid}` : "(text)"} ← ${f.source}`);
        }
        for (const s of r.skipReasons) {
          console.log(`    ✗ ${s.field}: ${s.reason}`);
        }
        for (const e of r.metafieldErrors) {
          console.log(`    ! ERROR: ${e}`);
        }
        for (const w of r.mappingWarnings) {
          console.log(`    ⚠ ${w}`);
        }
      } catch (e) {
        console.error(`    ${store} threw:`, e instanceof Error ? e.message : e);
      }
    }
    console.log();
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
