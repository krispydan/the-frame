/**
 * Dump every distinct tag/SKU value that the sync would try to write,
 * along with the Shopify handle it will resolve to. This is the "seed list"
 * — every handle that appears here needs a metaobject entry on each store.
 *
 * Run: npx tsx scripts/dump-tag-values.ts
 */
import { db } from "@/lib/db";
import { products, skus as skusTable, tags as tagsTable } from "@/modules/catalog/schema";
import { sql } from "drizzle-orm";
import { mapTagsToMetafields } from "@/modules/catalog/lib/shopify-metafields/tags-to-metafields";
import { inferColorHandles } from "@/modules/catalog/lib/shopify-metafields/color-mapping";

async function main() {
  // ── Distinct tag values by dimension ──
  const tagDistinct = await db
    .select({
      dimension: tagsTable.dimension,
      tagName: tagsTable.tagName,
      n: sql<number>`count(*)`,
    })
    .from(tagsTable)
    .groupBy(tagsTable.dimension, tagsTable.tagName);

  const byDim = new Map<string, Map<string, number>>();
  for (const row of tagDistinct) {
    const dim = (row.dimension ?? "(null)").toLowerCase();
    if (!byDim.has(dim)) byDim.set(dim, new Map());
    byDim.get(dim)!.set(row.tagName ?? "(null)", row.n);
  }

  for (const dim of ["lens", "frameshape", "frame_shape", "gender"]) {
    const m = byDim.get(dim);
    if (!m) continue;
    console.log(`\n── tags[dimension=${dim}] (${m.size} distinct) ──`);
    for (const [v, n] of [...m.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${n.toString().padStart(4)}  "${v}"`);
    }
  }

  // (Legacy product-column distribution removed — those columns no longer exist;
  // tags are the source of truth.)

  // ── SKU color names ──
  const skuRows = await db
    .select({ colorName: skusTable.colorName, n: sql<number>`count(*)` })
    .from(skusTable)
    .groupBy(skusTable.colorName);
  console.log(`\n── skus.color_name (${skuRows.length} distinct) ──`);
  const colorAgg = new Map<string, number>();
  const colorRaw: Array<[string, number]> = [];
  for (const r of skuRows) {
    if (!r.colorName) continue;
    colorRaw.push([r.colorName, r.n]);
  }
  for (const [v, n] of colorRaw.sort((a, b) => b[1] - a[1])) {
    const handles = inferColorHandles(v);
    console.log(`  ${n.toString().padStart(4)}  "${v}"  →  ${handles.length === 0 ? "(unmapped)" : handles.join(", ")}`);
    for (const h of handles) colorAgg.set(h, (colorAgg.get(h) ?? 0) + n);
  }

  // ── Resolved Shopify handles to seed (the actual list to seed on each store) ──
  console.log(`\n══════════════════════════════════════════════`);
  console.log(`SEED LIST — handles that need to exist as metaobjects on EACH store`);
  console.log(`══════════════════════════════════════════════`);

  // Walk every product and collect the full set of handles the sync would emit
  const allProducts = await db.select().from(products);
  const lensHandles = new Set<string>();
  const shapeHandles = new Set<string>();
  const genderHandles = new Set<string>();
  for (const p of allProducts) {
    if (!p.skuPrefix) continue;
    const tagRows = await db.select().from(tagsTable).where(sql`${tagsTable.productId} = ${p.id}`);
    const m = mapTagsToMetafields({
      tags: tagRows.map((t) => ({ dimension: t.dimension ?? "", tagName: t.tagName ?? null })),
    });
    if (m.lensPolarization) lensHandles.add(m.lensPolarization);
    if (m.eyewearFrameDesign) shapeHandles.add(m.eyewearFrameDesign);
    if (m.targetGender) genderHandles.add(m.targetGender);
  }

  console.log(`\nshopify--lens-polarization:`);
  for (const h of [...lensHandles].sort()) console.log(`  • ${h}`);
  console.log(`\nshopify--eyewear-frame-design:`);
  for (const h of [...shapeHandles].sort()) console.log(`  • ${h}`);
  console.log(`\nshopify--target-gender:`);
  for (const h of [...genderHandles].sort()) console.log(`  • ${h}`);
  console.log(`\nshopify--color-pattern:`);
  for (const [h, n] of [...colorAgg.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  • ${h}  (used by ${n} SKUs)`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
