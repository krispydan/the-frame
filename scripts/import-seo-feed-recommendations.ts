/**
 * One-shot importer: apply the visually-verified frame shapes and
 * marketing-curated SEO copy from
 * `jaxy-seo-feed-recommendations-v2.xlsx` to The Frame's catalog.
 *
 * What this script writes:
 *
 * 1. **Frame shape tag correction** — replaces the `frameShape`
 *    dimension tag on each product with the verified shape from the
 *    spreadsheet. Westside defaults to SQUARE per Daniel's call,
 *    despite the spreadsheet's FLAG. Six explicit corrections in the
 *    brief land via this pass (havana-haze, monroe, reverie,
 *    groove-theory, foundry, westside).
 *
 * 2. **`product_type` tag correction** — 10 products miscategorised as
 *    `optical` are switched to `sunglasses`. Source: the spreadsheet's
 *    "DATA QUALITY ISSUE" sheet plus brief §8 item 2.
 *
 * 3. **Wayfarer scrub** — replaces the trademarked "wayfarer" word in
 *    any product description with "classic square". Affects foundry +
 *    westside per brief §9.
 *
 * The script does NOT write `seo_title` / `meta_description` columns —
 * Daniel chose v1 to have no override mechanism, so any value written
 * here would be overwritten by the next nightly Shopify sync (Phase 4)
 * using the deterministic builders. The spreadsheet's recommended
 * titles are GOLDEN test cases instead (see Phase 6 vitest).
 *
 * Usage:
 *   npx tsx scripts/import-seo-feed-recommendations.ts            # dry-run
 *   npx tsx scripts/import-seo-feed-recommendations.ts --apply    # writes
 */

import * as fs from "fs";
import * as path from "path";
import * as xlsx from "xlsx";
import { sqlite } from "@/lib/db";

const DEFAULT_SHEET =
  "/Users/danielseeff/Library/CloudStorage/GoogleDrive-daniel@getjaxy.com/Shared drives/marketing/jaxy-seo-feed-recommendations-v2.xlsx";

// Sheet name -> verified frame shape per spreadsheet column. We coerce
// FLAG / LOW-confidence rows to the brief's call ahead of import (today
// that's just westside → square).
const FLAG_OVERRIDES: Record<string, string> = {
  westside: "SQUARE",
};

// Verified spreadsheet maps shape labels to lower-case canonical values
// matching TAG_PRESETS.frameShape.
const SHAPE_TO_CANONICAL: Record<string, string> = {
  ROUND: "round",
  SQUARE: "square",
  RECTANGLE: "rectangle",
  OVAL: "oval",
  "CAT-EYE": "cat-eye",
  CATEYE: "cat-eye",
  AVIATOR: "aviator",
  HEXAGONAL: "hexagonal",
  GEOMETRIC: "geometric",
  BUTTERFLY: "butterfly",
  OVERSIZED: "oversized",
};

// Products miscategorised as `optical` per brief §8 item 2. Switch the
// product_type tag to `sunglasses`.
const OPTICAL_TO_SUNGLASSES_HANDLES = [
  "vinyl", "studio", "cosmic", "eastwood", "westside",
  "lennon", "dynasty", "captain", "theory", "horizon",
];

interface VerifiedRow {
  handle: string;
  product: string;
  shape: string; // raw uppercase from spreadsheet (ROUND / FLAG / etc.)
}

function readVerifiedShapes(xlsxPath: string): VerifiedRow[] {
  const wb = xlsx.readFile(xlsxPath);
  const sheet = wb.Sheets["Verified Shapes"];
  if (!sheet) throw new Error("Sheet 'Verified Shapes' not found");
  const rows = xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet, { range: 3 });
  const out: VerifiedRow[] = [];
  for (const r of rows) {
    const handle = String(r["Handle"] ?? "").trim();
    const product = String(r["Product"] ?? "").trim();
    const shape = String(r["Verified Shape"] ?? "").trim().toUpperCase();
    if (!handle || !shape) continue;
    out.push({ handle, product, shape });
  }
  return out;
}

interface PlannedChange {
  productId: string;
  handle: string;
  productName: string;
  // null = no change for this category; string = new value to set
  newFrameShape: string | null;
  newProductType: string | null;
  oldDescription: string | null;
  newDescription: string | null;
}

/** Catalog products don't (currently) have a `slug` column — the Drizzle
 *  schema declares one but it was never ALTER-added. Match the
 *  spreadsheet's Shopify handle by name-as-slug instead. "The Regent" →
 *  "the-regent" matches handle "the-regent". Stripped of accents, &-
 *  encoded characters and apostrophes. */
function nameToHandle(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function planChanges(verified: VerifiedRow[]): { changes: PlannedChange[]; missing: string[] } {
  // Build a name→product map once; spreadsheet handles ARE the slugified
  // form of the product name.
  const allProducts = sqlite.prepare(
    `SELECT id, name, description FROM catalog_products`,
  ).all() as Array<{ id: string; name: string | null; description: string | null }>;
  const byHandle = new Map<string, { id: string; name: string; description: string | null }>();
  for (const p of allProducts) {
    if (!p.name) continue;
    byHandle.set(nameToHandle(p.name), {
      id: p.id, name: p.name, description: p.description,
    });
  }
  const findProduct = (handle: string) => byHandle.get(handle);
  const getCurrentShapeTag = sqlite.prepare(
    `SELECT tag_name FROM catalog_tags
      WHERE product_id = ? AND LOWER(dimension) IN ('frameshape','frame_shape')
      LIMIT 1`,
  );
  const getCurrentTypeTag = sqlite.prepare(
    `SELECT tag_name FROM catalog_tags
      WHERE product_id = ?
        AND LOWER(dimension) IN ('producttype','product_type','category')
      LIMIT 1`,
  );

  const opticalSet = new Set(OPTICAL_TO_SUNGLASSES_HANDLES);
  const changes: PlannedChange[] = [];
  const missing: string[] = [];

  for (const v of verified) {
    const p = findProduct(v.handle);
    if (!p) {
      missing.push(v.handle);
      continue;
    }

    // ── Frame shape ──
    const resolvedShape = FLAG_OVERRIDES[v.handle] ?? v.shape;
    const canonical = SHAPE_TO_CANONICAL[resolvedShape];
    let newFrameShape: string | null = null;
    if (canonical) {
      const cur = getCurrentShapeTag.get(p.id) as { tag_name: string } | undefined;
      if (!cur || (cur.tag_name ?? "").toLowerCase() !== canonical) {
        newFrameShape = canonical;
      }
    }

    // ── product_type for the 10 optical-mislabelled handles ──
    let newProductType: string | null = null;
    if (opticalSet.has(v.handle)) {
      const cur = getCurrentTypeTag.get(p.id) as { tag_name: string } | undefined;
      const curVal = (cur?.tag_name ?? "").toLowerCase();
      if (curVal !== "sunglasses") newProductType = "sunglasses";
    }

    // ── Wayfarer scrub on description ──
    let newDescription: string | null = null;
    if (p.description && /wayfarer/i.test(p.description)) {
      newDescription = p.description.replace(/wayfarer/gi, "classic square");
    }

    if (newFrameShape || newProductType || newDescription) {
      changes.push({
        productId: p.id,
        handle: v.handle,
        productName: p.name ?? v.product,
        newFrameShape,
        newProductType,
        oldDescription: newDescription ? p.description : null,
        newDescription,
      });
    }
  }

  return { changes, missing };
}

function applyChange(c: PlannedChange) {
  const deleteShapeTag = sqlite.prepare(
    `DELETE FROM catalog_tags
      WHERE product_id = ?
        AND LOWER(dimension) IN ('frameshape','frame_shape')`,
  );
  const deleteTypeTag = sqlite.prepare(
    `DELETE FROM catalog_tags
      WHERE product_id = ?
        AND LOWER(dimension) IN ('producttype','product_type','category')`,
  );
  const insertTag = sqlite.prepare(
    `INSERT INTO catalog_tags (id, product_id, tag_name, dimension, source)
     VALUES (?, ?, ?, ?, 'manual')`,
  );
  const updateDescription = sqlite.prepare(
    `UPDATE catalog_products SET description = ?, updated_at = datetime('now')
      WHERE id = ?`,
  );

  const txn = sqlite.transaction(() => {
    if (c.newFrameShape) {
      deleteShapeTag.run(c.productId);
      insertTag.run(crypto.randomUUID(), c.productId, c.newFrameShape, "frameShape");
    }
    if (c.newProductType) {
      deleteTypeTag.run(c.productId);
      insertTag.run(crypto.randomUUID(), c.productId, c.newProductType, "productType");
    }
    if (c.newDescription) {
      updateDescription.run(c.newDescription, c.productId);
    }
  });
  txn();
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const xlsxPath = args.find((a) => !a.startsWith("--")) ?? DEFAULT_SHEET;

  if (!fs.existsSync(xlsxPath)) {
    console.error(`Input not found: ${xlsxPath}`);
    process.exit(1);
  }
  console.log(`Reading: ${xlsxPath}`);

  const verified = readVerifiedShapes(xlsxPath);
  console.log(`Loaded ${verified.length} verified rows.`);

  const { changes, missing } = planChanges(verified);

  if (missing.length > 0) {
    console.warn(`\nNo product found for ${missing.length} handles:`);
    for (const h of missing) console.warn(`  ${h}`);
  }

  if (changes.length === 0) {
    console.log("\nNothing to update. Catalog already matches the spreadsheet.");
    return;
  }

  console.log(`\nPlanned changes for ${changes.length} products:`);
  for (const c of changes) {
    const bits: string[] = [];
    if (c.newFrameShape) bits.push(`frameShape → ${c.newFrameShape}`);
    if (c.newProductType) bits.push(`productType → ${c.newProductType}`);
    if (c.newDescription) bits.push(`description: wayfarer scrub`);
    console.log(`  ${c.handle.padEnd(20)}  ${bits.join(", ")}`);
  }

  if (!apply) {
    console.log(`\nDry-run only. Re-run with --apply to write.`);
    return;
  }

  console.log(`\nApplying...`);
  let applied = 0;
  for (const c of changes) {
    try {
      applyChange(c);
      applied++;
    } catch (e) {
      console.warn(`  ✗ ${c.handle}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`Applied ${applied}/${changes.length} updates.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
