/**
 * Phase 1 backfill — populates:
 *
 *   1. `catalog_products.amazon_group_key` from the curated `frameShape`
 *      tag. Drives Phase 4's group iteration.
 *
 *   2. `materialFrame` tag for products that don't have one. Per
 *      Daniel's call: default = `acetate`; Raven (JX3006) and Drifter
 *      (JX2003) = `metal`. This keeps the Amazon parent's
 *      frame_material_type honest without manual tag work.
 *
 * Idempotent — re-runnable. Reports per-action counts.
 *
 * Usage:
 *   npx tsx scripts/backfill-amazon-group-key.ts            # dry-run
 *   npx tsx scripts/backfill-amazon-group-key.ts --apply    # writes
 */

import { sqlite } from "@/lib/db";
import { curatedAttrsFromTags } from "@/modules/catalog/lib/curated-attributes";

// Per Daniel: metal frames are Raven (JX3006) + Drifter (JX2002).
// Both are ALREADY tagged materialFrame=metal in the catalog — the
// audit confirmed it. This set covers any product that's metal but
// somehow lost its tag (currently empty). All other untagged
// products default to acetate below.
const METAL_SKU_PREFIXES = new Set<string>([]);

interface ProductRow {
  id: string;
  name: string | null;
  sku_prefix: string | null;
  amazon_group_key: string | null;
}

interface TagRow {
  id: string;
  product_id: string;
  tag_name: string | null;
  dimension: string | null;
}

async function main() {
  const apply = process.argv.includes("--apply");

  const products = sqlite.prepare(
    `SELECT id, name, sku_prefix, amazon_group_key FROM catalog_products`,
  ).all() as ProductRow[];

  const tags = sqlite.prepare(
    `SELECT id, product_id, tag_name, dimension FROM catalog_tags`,
  ).all() as TagRow[];

  const tagsByProduct = new Map<string, TagRow[]>();
  for (const t of tags) {
    if (!tagsByProduct.has(t.product_id)) tagsByProduct.set(t.product_id, []);
    tagsByProduct.get(t.product_id)!.push(t);
  }

  interface PlannedChange {
    productId: string;
    productName: string;
    skuPrefix: string;
    newAmazonGroupKey?: string;
    addMaterialTag?: "acetate" | "metal";
  }

  const changes: PlannedChange[] = [];
  const skipped = { noShape: 0, materialAlreadySet: 0, groupAlreadySet: 0 };

  for (const p of products) {
    const productTags = tagsByProduct.get(p.id) ?? [];
    const curated = curatedAttrsFromTags(
      productTags.map((t) => ({ dimension: t.dimension ?? "", tagName: t.tag_name ?? null })),
    );

    let newGroupKey: string | undefined;
    if (curated.frameShape) {
      const key = curated.frameShape.toLowerCase();
      if (p.amazon_group_key === key) {
        skipped.groupAlreadySet++;
      } else {
        newGroupKey = key;
      }
    } else {
      skipped.noShape++;
    }

    let addMaterialTag: "acetate" | "metal" | undefined;
    const hasMaterialFrameTag = productTags.some(
      (t) => (t.dimension ?? "").toLowerCase() === "materialframe",
    );
    if (!hasMaterialFrameTag) {
      const skuPrefix = (p.sku_prefix ?? "").toUpperCase();
      addMaterialTag = METAL_SKU_PREFIXES.has(skuPrefix) ? "metal" : "acetate";
    } else {
      skipped.materialAlreadySet++;
    }

    if (newGroupKey || addMaterialTag) {
      changes.push({
        productId: p.id,
        productName: p.name ?? "(unnamed)",
        skuPrefix: p.sku_prefix ?? "(no-prefix)",
        newAmazonGroupKey: newGroupKey,
        addMaterialTag,
      });
    }
  }

  console.log(`Scope: ${products.length} products`);
  console.log(`Skipped reasons:`);
  console.log(`  no frameShape tag:       ${skipped.noShape}`);
  console.log(`  amazon_group_key already set: ${skipped.groupAlreadySet}`);
  console.log(`  materialFrame already set: ${skipped.materialAlreadySet}`);

  if (changes.length === 0) {
    console.log(`\nNo changes needed.`);
    return;
  }

  console.log(`\nPlanned changes for ${changes.length} products:`);
  for (const c of changes) {
    const bits: string[] = [];
    if (c.newAmazonGroupKey) bits.push(`group_key=${c.newAmazonGroupKey}`);
    if (c.addMaterialTag) bits.push(`+materialFrame:${c.addMaterialTag}`);
    console.log(`  ${c.skuPrefix.padEnd(10)} ${c.productName.padEnd(22)} ${bits.join(", ")}`);
  }

  if (!apply) {
    console.log(`\nDry-run. Re-run with --apply to write.`);
    return;
  }

  const updateGroupKey = sqlite.prepare(
    `UPDATE catalog_products SET amazon_group_key = ?, updated_at = datetime('now')
       WHERE id = ?`,
  );
  const insertTag = sqlite.prepare(
    `INSERT INTO catalog_tags (id, product_id, tag_name, dimension, source)
     VALUES (?, ?, ?, 'materialFrame', 'manual')`,
  );

  let applied = 0;
  const txn = sqlite.transaction(() => {
    for (const c of changes) {
      if (c.newAmazonGroupKey) {
        updateGroupKey.run(c.newAmazonGroupKey, c.productId);
      }
      if (c.addMaterialTag) {
        insertTag.run(crypto.randomUUID(), c.productId, c.addMaterialTag);
      }
      applied++;
    }
  });
  txn();
  console.log(`\nApplied ${applied} updates.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
