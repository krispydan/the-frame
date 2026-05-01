/**
 * Audit which columns on catalog_products overlap with catalog_tags so we
 * can decide what to retire. For every candidate column on every product
 * we compare:
 *   • column value
 *   • all tag values in matching dimension(s)
 * and bucket each product into one of:
 *   match     — column value present in tags (safe to drop column)
 *   col-only  — column has data, tags have nothing → would lose data
 *   tag-only  — tags have data, column is empty → already tag-driven
 *   conflict  — both have data but they disagree → needs decision
 *   empty     — neither side has data
 *
 * Run: npx tsx scripts/audit-columns-vs-tags.ts
 */
import { db } from "@/lib/db";
import { products, tags as tagsTable } from "@/modules/catalog/schema";

type Bucket = "match" | "col-only" | "tag-only" | "conflict" | "empty";

interface ColumnSpec {
  /** Drizzle column name (TS) used to read the value from a product row. */
  field: keyof typeof products extends string
    ? string
    : never;
  /** Display label for the report. */
  label: string;
  /** All tag dimensions (lowercased) that mean the same thing as this column. */
  dimensions: string[];
  /** Optional value normalizer when comparing column ↔ tag values. */
  normalize?: (v: string) => string;
}

const lower = (v: string) => v.trim().toLowerCase();

const SPECS: ColumnSpec[] = [
  { field: "frameShape", label: "frame_shape", dimensions: ["frameshape", "frame_shape"], normalize: lower },
  { field: "frameMaterial", label: "frame_material", dimensions: ["framematerial", "frame_material", "material"], normalize: lower },
  { field: "lensType", label: "lens_type", dimensions: ["lens", "lenstype", "lens_type"], normalize: lower },
  { field: "gender", label: "gender", dimensions: ["gender"], normalize: lower },
  { field: "category", label: "category", dimensions: ["category", "producttype", "product_type"], normalize: lower },
];

async function main() {
  const allProducts = await db.select().from(products);
  const allTags = await db.select().from(tagsTable);

  // Index tags by product for O(1) lookup
  const tagsByProduct = new Map<string, Array<{ dimension: string; tagName: string }>>();
  for (const t of allTags) {
    if (!t.productId) continue;
    if (!tagsByProduct.has(t.productId)) tagsByProduct.set(t.productId, []);
    tagsByProduct.get(t.productId)!.push({
      dimension: (t.dimension ?? "").trim().toLowerCase(),
      tagName: (t.tagName ?? "").trim(),
    });
  }

  // Per-product, per-spec bucketing
  const buckets: Record<string, Record<Bucket, Array<{ skuPrefix: string; col: string | null; tagVals: string[] }>>> = {};
  for (const spec of SPECS) {
    buckets[spec.label] = { match: [], "col-only": [], "tag-only": [], conflict: [], empty: [] };
  }

  for (const p of allProducts) {
    if (!p.skuPrefix) continue;
    const productTags = tagsByProduct.get(p.id) ?? [];
    for (const spec of SPECS) {
      const colRaw = (p as Record<string, unknown>)[spec.field] as string | null | undefined;
      const colVal = colRaw ? colRaw.trim() : null;
      const colKey = colVal ? (spec.normalize ? spec.normalize(colVal) : colVal) : null;

      const tagsInDim = productTags.filter((t) => spec.dimensions.includes(t.dimension));
      const tagVals = tagsInDim.map((t) => t.tagName).filter((v) => v.length > 0);
      const tagKeys = new Set(tagVals.map((v) => (spec.normalize ? spec.normalize(v) : v)));

      let bucket: Bucket;
      if (!colVal && tagVals.length === 0) bucket = "empty";
      else if (colVal && tagVals.length === 0) bucket = "col-only";
      else if (!colVal && tagVals.length > 0) bucket = "tag-only";
      else if (colKey && tagKeys.has(colKey)) bucket = "match";
      else bucket = "conflict";

      buckets[spec.label][bucket].push({ skuPrefix: p.skuPrefix, col: colVal, tagVals });
    }
  }

  // ── Summary table ──
  console.log("\n══════════════════════════════════════════════════════════════════════════════════");
  console.log(`  COLUMN vs TAGS AUDIT — ${allProducts.length} products`);
  console.log("══════════════════════════════════════════════════════════════════════════════════\n");
  const head = ["column".padEnd(16), "match".padStart(7), "col-only".padStart(9), "tag-only".padStart(9), "conflict".padStart(9), "empty".padStart(7)].join(" │ ");
  console.log(`  ${head}`);
  console.log("  " + "─".repeat(head.length));
  for (const spec of SPECS) {
    const b = buckets[spec.label];
    const row = [
      spec.label.padEnd(16),
      String(b.match.length).padStart(7),
      String(b["col-only"].length).padStart(9),
      String(b["tag-only"].length).padStart(9),
      String(b.conflict.length).padStart(9),
      String(b.empty.length).padStart(7),
    ].join(" │ ");
    console.log(`  ${row}`);
  }
  console.log();
  console.log("  Legend:");
  console.log("    match     = column value is also represented in tags (safe to drop column)");
  console.log("    col-only  = column has data, no matching tag rows (DATA WOULD BE LOST if dropped)");
  console.log("    tag-only  = tags have data, column is empty (already tag-driven)");
  console.log("    conflict  = both populated but they disagree (needs reconciliation)");
  console.log("    empty     = neither populated");

  // ── Per-spec detail: only print rows that warrant action ──
  for (const spec of SPECS) {
    const b = buckets[spec.label];
    const colOnly = b["col-only"];
    const conflict = b.conflict;
    if (colOnly.length === 0 && conflict.length === 0) continue;

    console.log(`\n──────────────────────────── ${spec.label} ────────────────────────────`);

    if (colOnly.length > 0) {
      console.log(`\n  COL-ONLY (${colOnly.length}) — would lose this data:`);
      // Group by column value
      const byVal = new Map<string, string[]>();
      for (const r of colOnly) {
        const v = r.col ?? "";
        if (!byVal.has(v)) byVal.set(v, []);
        byVal.get(v)!.push(r.skuPrefix);
      }
      for (const [v, skus] of [...byVal.entries()].sort((a, b) => b[1].length - a[1].length)) {
        console.log(`    "${v}"  (${skus.length} products): ${skus.slice(0, 8).join(", ")}${skus.length > 8 ? `, …+${skus.length - 8}` : ""}`);
      }
    }

    if (conflict.length > 0) {
      console.log(`\n  CONFLICT (${conflict.length}) — column says X, tags say Y:`);
      for (const r of conflict.slice(0, 30)) {
        console.log(`    ${r.skuPrefix.padEnd(8)}  col="${r.col}"  tags=[${r.tagVals.join(", ")}]`);
      }
      if (conflict.length > 30) console.log(`    … +${conflict.length - 30} more`);
    }
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
