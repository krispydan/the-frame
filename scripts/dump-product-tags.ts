/**
 * Dump every tag + product field for a SKU prefix so we can see exactly what
 * the-frame thinks the product is.
 * Run: npx tsx scripts/dump-product-tags.ts JX1001
 */
import { db } from "@/lib/db";
import { products, skus as skusTable, tags as tagsTable } from "@/modules/catalog/schema";
import { eq } from "drizzle-orm";

async function main() {
  const skuPrefix = process.argv[2] || "JX1001";
  const product = (await db.select().from(products).where(eq(products.skuPrefix, skuPrefix)))[0];
  if (!product) { console.error("not found"); process.exit(1); }

  console.log(`\nProduct ${product.skuPrefix} — ${product.name}`);
  console.log();

  const skuRows = await db.select().from(skusTable).where(eq(skusTable.productId, product.id));
  console.log(`SKUs (${skuRows.length}):`);
  for (const s of skuRows) console.log(`  ${s.sku}  color="${s.colorName}"`);
  console.log();

  const tagRows = await db.select().from(tagsTable).where(eq(tagsTable.productId, product.id));
  console.log(`Tags (${tagRows.length}):`);
  // Group by dimension
  const byDim = new Map<string, string[]>();
  for (const t of tagRows) {
    const d = t.dimension ?? "(none)";
    if (!byDim.has(d)) byDim.set(d, []);
    byDim.get(d)!.push(t.tagName ?? "(null)");
  }
  for (const [d, vs] of [...byDim.entries()].sort()) {
    console.log(`  ${d.padEnd(20)}  (${vs.length}): ${[...new Set(vs)].sort().join(", ")}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
