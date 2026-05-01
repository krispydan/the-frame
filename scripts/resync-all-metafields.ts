/**
 * Re-sync the 4 tag-curated Shopify metafields for every product on
 * both stores. Run after pulling fresh data from prod (so tags are
 * authoritative).
 *
 * Usage:
 *   npx tsx scripts/resync-all-metafields.ts            # dry run
 *   npx tsx scripts/resync-all-metafields.ts --live     # actually write
 */
import { db } from "@/lib/db";
import { products, skus as skusTable, tags as tagsTable } from "@/modules/catalog/schema";
import { eq } from "drizzle-orm";
import { syncMetafieldsFromTags } from "@/modules/catalog/lib/shopify-metafields/sync-from-tags";

interface RunSummary {
  store: "dtc" | "wholesale";
  ok: number;
  partial: number;
  failed: number;
  skuFailures: string[];
}

async function main() {
  const live = process.argv.includes("--live");
  const allProducts = await db.select().from(products);

  console.log(`Mode: ${live ? "LIVE" : "DRY RUN"}`);
  console.log(`Products: ${allProducts.length}\n`);

  const summary: Record<string, RunSummary> = {
    dtc: { store: "dtc", ok: 0, partial: 0, failed: 0, skuFailures: [] },
    wholesale: { store: "wholesale", ok: 0, partial: 0, failed: 0, skuFailures: [] },
  };

  for (const product of allProducts) {
    if (!product.skuPrefix) continue;
    const tagRows = await db.select().from(tagsTable).where(eq(tagsTable.productId, product.id));
    const skuRows = await db
      .select({ colorName: skusTable.colorName })
      .from(skusTable)
      .where(eq(skusTable.productId, product.id));

    process.stdout.write(`${product.skuPrefix.padEnd(8)} ${(product.name || "?").padEnd(20)} `);
    for (const store of ["dtc", "wholesale"] as const) {
      try {
        const r = await syncMetafieldsFromTags({
          store,
          skuPrefix: product.skuPrefix,
          tags: tagRows.map((t) => ({ dimension: t.dimension ?? "", tagName: t.tagName ?? null })),
          skuColorNames: skuRows.map((s) => s.colorName),
          dryRun: !live,
        });
        const fullySuccessful = r.ok && r.skipReasons.length === 0 && r.metafieldErrors.length === 0;
        if (fullySuccessful) {
          summary[store].ok++;
          process.stdout.write(`${store}=ok(${r.metafieldsAttempted})  `);
        } else if (r.ok) {
          summary[store].partial++;
          process.stdout.write(`${store}=partial(${r.metafieldsAttempted}/${r.skipReasons.length}skip)  `);
        } else {
          summary[store].failed++;
          summary[store].skuFailures.push(`${product.skuPrefix}: ${r.metafieldErrors.join("; ")}`);
          process.stdout.write(`${store}=FAIL  `);
        }
      } catch (e) {
        summary[store].failed++;
        summary[store].skuFailures.push(`${product.skuPrefix}: ${e instanceof Error ? e.message : "?"}`);
        process.stdout.write(`${store}=THROW  `);
      }
    }
    process.stdout.write("\n");
  }

  console.log(`\n══════ Summary ══════`);
  for (const s of Object.values(summary)) {
    console.log(
      `  ${s.store.padEnd(10)} ok=${s.ok}  partial=${s.partial}  failed=${s.failed}`,
    );
    if (s.skuFailures.length > 0) {
      console.log(`    failures:`);
      for (const f of s.skuFailures.slice(0, 10)) console.log(`      ${f}`);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
