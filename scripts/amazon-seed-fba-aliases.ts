/**
 * Seed `catalog_sku_aliases` for Amazon's `-FBA` SKU variants.
 *
 *   npx tsx scripts/amazon-seed-fba-aliases.ts            # dry run (default)
 *   npx tsx scripts/amazon-seed-fba-aliases.ts --apply
 *
 * Amazon SKUs are our SKU plus an optional `-FBA` suffix marking stock sent to
 * Amazon's warehouse (`JX1010-TOR-FBA`) versus stock shipped from ours
 * (`JX4006-BLK`). Both are listings for the same physical product, so costing
 * must resolve them to one internal SKU.
 *
 * This is done with alias rows rather than a suffix-strip in the costing code
 * on purpose: zero code risk, visible and editable in the UI, and one-off odd
 * SKUs get handled the same way as the regular ones. The importer already
 * strips the suffix when resolving, so aliases are only needed where the
 * stripped SKU still does not match the catalog.
 *
 * Dry run by default — it prints exactly what it would write and changes
 * nothing until `--apply`.
 */

import { sqlite } from "@/lib/db";
import { toInternalSku } from "@/modules/integrations/lib/amazon/ingest";

interface Row { sku: string; units: number }

function main() {
  const apply = process.argv.includes("--apply");

  // Every distinct Amazon SKU we have actually sold, most-sold first so the
  // output is ordered by how much each mapping matters.
  const amazonSkus = sqlite.prepare(`
    SELECT oi.sku AS sku, SUM(oi.quantity) AS units
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.channel = 'amazon' AND oi.sku IS NOT NULL
    GROUP BY oi.sku
    ORDER BY units DESC
  `).all() as Row[];

  if (amazonSkus.length === 0) {
    console.log("No Amazon order lines found. Run the order import first.");
    return;
  }

  const resolved: string[] = [];
  const toCreate: Array<{ amazonSku: string; internalSku: string; skuId: string; units: number }> = [];
  const unresolvable: Array<{ amazonSku: string; internalSku: string | null; units: number }> = [];

  for (const { sku, units } of amazonSkus) {
    const internalSku = toInternalSku(sku);
    if (!internalSku) { unresolvable.push({ amazonSku: sku, internalSku: null, units }); continue; }

    // Already resolvable? Then no alias is needed — the importer's suffix
    // strip is enough, and an alias would be redundant noise in the UI.
    const direct = sqlite.prepare("SELECT id FROM catalog_skus WHERE sku = ? LIMIT 1")
      .get(internalSku) as { id: string } | undefined;
    const existingAlias = sqlite.prepare("SELECT sku_id FROM catalog_sku_aliases WHERE alias = ? LIMIT 1")
      .get(sku) as { sku_id: string } | undefined;

    if (direct || existingAlias) { resolved.push(sku); continue; }

    // The stripped SKU does not match the catalog. Only an operator can say
    // what it should map to, so report rather than guess.
    unresolvable.push({ amazonSku: sku, internalSku, units });
  }

  console.log(`\nAmazon SKUs sold: ${amazonSkus.length}`);
  console.log(`  already resolve: ${resolved.length}`);
  console.log(`  aliases to create: ${toCreate.length}`);
  console.log(`  cannot be resolved automatically: ${unresolvable.length}`);

  if (unresolvable.length > 0) {
    console.log(`\nThese need a decision — the SKU does not exist in catalog_skus after stripping "-FBA":`);
    for (const u of unresolvable) {
      console.log(`  ${u.amazonSku.padEnd(24)} → ${String(u.internalSku).padEnd(20)} (${u.units} units sold)`);
    }
    console.log(
      `\nEither add the product to the catalog, or map it to an existing SKU with:\n` +
      `  INSERT INTO catalog_sku_aliases (alias, sku_id, canonical_sku, note)\n` +
      `  VALUES ('<internal sku>', '<catalog_skus.id>', '<canonical>', 'Amazon FBA listing');`,
    );
  }

  if (toCreate.length === 0) {
    console.log("\nNothing to write.\n");
    return;
  }

  if (!apply) {
    console.log("\nDry run — re-run with --apply to write these aliases.\n");
    return;
  }

  const insert = sqlite.prepare(`
    INSERT OR IGNORE INTO catalog_sku_aliases (alias, sku_id, canonical_sku, note)
    VALUES (?, ?, ?, 'Amazon FBA listing variant')
  `);
  const run = sqlite.transaction(() => {
    for (const a of toCreate) insert.run(a.amazonSku, a.skuId, a.internalSku);
  });
  run();
  console.log(`\nWrote ${toCreate.length} alias row(s).\n`);
}

main();
