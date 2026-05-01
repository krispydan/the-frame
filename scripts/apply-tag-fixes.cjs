const Database = require("better-sqlite3");
const crypto = require("crypto");
const db = new Database(process.env.DATABASE_PATH);

const newId = () => crypto.randomUUID();

const txn = db.transaction(() => {
  // ── 1. Fix lens tag: polarized → uv400 for the 6 SKUs ──
  const lensSkus = ["JX1003","JX1008","JX2002","JX2003","JX2005","JX2007"];
  const updateLens = db.prepare(`
    UPDATE catalog_tags
    SET tag_name = 'uv400'
    WHERE dimension = 'lens'
      AND tag_name = 'polarized'
      AND product_id = (SELECT id FROM catalog_products WHERE sku_prefix = ?)
  `);
  let lensFixed = 0;
  for (const sku of lensSkus) {
    const r = updateLens.run(sku);
    lensFixed += r.changes;
    console.log(`  lens fix ${sku}: ${r.changes} row(s)`);
  }

  // ── 2. JX3003: add gender (male+female), frameShape (square), productType (sunglasses) ──
  const jx3003 = db.prepare("SELECT id FROM catalog_products WHERE sku_prefix = 'JX3003'").get();
  if (!jx3003) throw new Error("JX3003 not found");
  const insertTag = db.prepare(`
    INSERT INTO catalog_tags (id, product_id, tag_name, dimension, source)
    VALUES (?, ?, ?, ?, 'manual')
  `);
  // Skip if already present (idempotent)
  const exists = db.prepare(`
    SELECT 1 FROM catalog_tags WHERE product_id = ? AND dimension = ? AND tag_name = ?
  `);
  const additions = [
    ["male", "gender"],
    ["female", "gender"],
    ["square", "frameShape"],
    ["sunglasses", "productType"],
  ];
  for (const [tagName, dim] of additions) {
    if (exists.get(jx3003.id, dim, tagName)) {
      console.log(`  JX3003 already has ${dim}=${tagName} — skipped`);
      continue;
    }
    insertTag.run(newId(), jx3003.id, tagName, dim);
    console.log(`  JX3003 +${dim}=${tagName}`);
  }

  // ── 3. JX1003: add frameShape=round (camelCase, our canonical) ──
  const jx1003 = db.prepare("SELECT id FROM catalog_products WHERE sku_prefix = 'JX1003'").get();
  if (!jx1003) throw new Error("JX1003 not found");
  if (exists.get(jx1003.id, "frameShape", "round")) {
    console.log("  JX1003 already has frameShape=round — skipped");
  } else {
    insertTag.run(newId(), jx1003.id, "round", "frameShape");
    console.log("  JX1003 +frameShape=round");
  }
  // Remove the conflicting cat-eye tag (legacy snake_case dimension stays for now,
  // we'll wipe all snake_case in the cleanup phase)
  const removed = db.prepare(`
    DELETE FROM catalog_tags
    WHERE product_id = ? AND dimension = 'frame_shape' AND tag_name = 'cat-eye'
  `).run(jx1003.id);
  console.log(`  JX1003 removed legacy frame_shape=cat-eye: ${removed.changes} row(s)`);

  console.log(`\n  Total lens fixes: ${lensFixed}`);
});

console.log("Applying fixes on PRODUCTION DB:");
txn();
console.log("\nDone.");

// Verify
console.log("\n── Verify lens tags for affected SKUs ──");
for (const sku of ["JX1003","JX1008","JX2002","JX2003","JX2005","JX2007"]) {
  const rows = db.prepare(`
    SELECT t.dimension, t.tag_name FROM catalog_tags t
    JOIN catalog_products p ON p.id = t.product_id
    WHERE p.sku_prefix = ? AND t.dimension = 'lens'
  `).all(sku);
  console.log(`  ${sku}: ${rows.map(r => r.dimension+'='+r.tag_name).join(', ') || '(none)'}`);
}
console.log("\n── JX3003 tags ──");
const jx3003tags = db.prepare(`
  SELECT t.dimension, t.tag_name FROM catalog_tags t
  JOIN catalog_products p ON p.id = t.product_id
  WHERE p.sku_prefix = 'JX3003' ORDER BY dimension, tag_name
`).all();
for (const r of jx3003tags) console.log(`  ${r.dimension}=${r.tag_name}`);
console.log("\n── JX1003 frameShape tags (all dimensions) ──");
const jx1003tags = db.prepare(`
  SELECT t.dimension, t.tag_name FROM catalog_tags t
  JOIN catalog_products p ON p.id = t.product_id
  WHERE p.sku_prefix = 'JX1003' AND (t.dimension = 'frameShape' OR t.dimension = 'frame_shape')
`).all();
for (const r of jx1003tags) console.log(`  ${r.dimension}=${r.tag_name}`);
