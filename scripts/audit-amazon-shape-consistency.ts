/**
 * Phase 0 of the Amazon group-restructure plan
 * (~/.claude/plans/tender-dazzling-sparkle.md).
 *
 * Walks every catalog_product, computes its proposed Amazon group key
 * (currently `frameShape`), and tabulates the inherited Amazon
 * fields per group:
 *
 *   - frame_material_type
 *   - lens_material_type
 *   - polarization_type
 *   - target_gender
 *
 * Amazon enforces single inherited values at the parent row level —
 * if any of these fields has >1 distinct value within a shape group,
 * that group MUST be split (e.g. SQUARE-acetate vs SQUARE-metal)
 * before the restructure can land.
 *
 * Read-only. No DB writes. Run before any code in Phase 1.
 *
 * Usage:
 *   npx tsx scripts/audit-amazon-shape-consistency.ts
 */

import { sqlite } from "@/lib/db";
import { curatedAttrsFromTags } from "@/modules/catalog/lib/curated-attributes";
import {
  mapFrameMaterial,
  mapLensMaterial,
  mapPolarizationFromTags,
} from "@/modules/catalog/lib/amazon/tag-attrs";

interface ProductRow {
  id: string;
  name: string | null;
  sku_prefix: string | null;
}

interface TagRow {
  product_id: string;
  tag_name: string | null;
  dimension: string | null;
}

interface ProductAudit {
  productId: string;
  productName: string;
  skuPrefix: string;
  frameShape: string;
  frameMaterial: string | null;
  lensMaterial: string | null;
  polarization: string;
  gender: string | null;
}

interface GroupSummary {
  groupKey: string;
  products: ProductAudit[];
  frameMaterials: Map<string, number>;
  lensMaterials: Map<string, number>;
  polarizations: Map<string, number>;
  genders: Map<string, number>;
}

function increment(m: Map<string, number>, key: string | null) {
  const k = key ?? "(null)";
  m.set(k, (m.get(k) ?? 0) + 1);
}

function summariseField(label: string, m: Map<string, number>, total: number): string {
  const entries = Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  if (entries.length <= 1) {
    return `  ✓ ${label.padEnd(22)} ${entries[0]?.[0] ?? "(empty)"} (${entries[0]?.[1] ?? 0}/${total})`;
  }
  const breakdown = entries.map(([v, n]) => `${v}=${n}`).join(", ");
  return `  ✗ ${label.padEnd(22)} MIXED (${breakdown})`;
}

async function main() {
  console.log("Loading products + tags…");
  const products = sqlite.prepare(
    `SELECT id, name, sku_prefix FROM catalog_products`,
  ).all() as ProductRow[];

  const tags = sqlite.prepare(
    `SELECT product_id, tag_name, dimension FROM catalog_tags`,
  ).all() as TagRow[];
  const tagsByProduct = new Map<string, TagRow[]>();
  for (const t of tags) {
    if (!tagsByProduct.has(t.product_id)) tagsByProduct.set(t.product_id, []);
    tagsByProduct.get(t.product_id)!.push(t);
  }

  const groups = new Map<string, GroupSummary>();
  let withoutShape = 0;

  for (const p of products) {
    const productTags = tagsByProduct.get(p.id) ?? [];
    const curated = curatedAttrsFromTags(
      productTags.map((t) => ({ dimension: t.dimension ?? "", tagName: t.tag_name ?? null })),
    );
    if (!curated.frameShape) {
      withoutShape++;
      continue;
    }
    const groupKey = curated.frameShape.toLowerCase();
    const frameMaterial = mapFrameMaterial(curated.frameMaterial);
    const lensMaterial = mapLensMaterial(curated.lensType);
    const tagSet = new Set(productTags.map((t) => (t.tag_name ?? "").toLowerCase()));
    const polarization = mapPolarizationFromTags(tagSet);

    const audit: ProductAudit = {
      productId: p.id,
      productName: p.name ?? "(unnamed)",
      skuPrefix: p.sku_prefix ?? "(no-prefix)",
      frameShape: curated.frameShape,
      frameMaterial,
      lensMaterial,
      polarization,
      gender: curated.gender,
    };

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        groupKey,
        products: [],
        frameMaterials: new Map(),
        lensMaterials: new Map(),
        polarizations: new Map(),
        genders: new Map(),
      });
    }
    const g = groups.get(groupKey)!;
    g.products.push(audit);
    increment(g.frameMaterials, frameMaterial);
    increment(g.lensMaterials, lensMaterial);
    increment(g.polarizations, polarization);
    increment(g.genders, curated.gender);
  }

  // ── Report ──
  const totalGrouped = Array.from(groups.values()).reduce((s, g) => s + g.products.length, 0);
  console.log(`\nTotal products: ${products.length}`);
  console.log(`  Grouped: ${totalGrouped}`);
  console.log(`  Without frameShape (excluded): ${withoutShape}`);
  console.log(`\nGroups: ${groups.size}`);

  const sortedGroups = Array.from(groups.values()).sort((a, b) => b.products.length - a.products.length);

  let needsSplit = false;
  for (const g of sortedGroups) {
    const inconsistent =
      g.frameMaterials.size > 1 ||
      g.lensMaterials.size > 1 ||
      g.polarizations.size > 1 ||
      g.genders.size > 1;
    if (inconsistent) needsSplit = true;

    console.log(`\n─── ${g.groupKey.toUpperCase()}  (${g.products.length} styles) ${inconsistent ? "✗ NEEDS SPLIT" : "✓ OK"}`);
    console.log(summariseField("frame_material_type", g.frameMaterials, g.products.length));
    console.log(summariseField("lens_material_type", g.lensMaterials, g.products.length));
    console.log(summariseField("polarization_type", g.polarizations, g.products.length));
    console.log(summariseField("target_gender", g.genders, g.products.length));

    if (inconsistent) {
      console.log("  Styles in this group:");
      for (const p of g.products) {
        console.log(
          `    ${p.skuPrefix.padEnd(10)} ${p.productName.padEnd(20)} ` +
          `frame=${p.frameMaterial ?? "?"} lens=${p.lensMaterial ?? "?"} ` +
          `pol=${p.polarization} gender=${p.gender ?? "?"}`,
        );
      }
    }
  }

  console.log(`\n${"─".repeat(60)}`);
  if (needsSplit) {
    console.log("⚠ Some groups have inconsistent inherited fields and need to");
    console.log("  be split before Phase 1 can land. See ✗ markers above.");
    console.log("  Each split adds one more Amazon parent listing.");
  } else {
    console.log("✓ All groups have consistent inherited fields.");
    console.log("  Safe to proceed with Phase 1 — one parent per shape.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
