/**
 * Dump every product's SEO-relevant data in one structured JSON blob,
 * so we can hand-write SEO copy product-by-product without burning an
 * API key.
 *
 * Run: npx tsx scripts/dump-seo-input.ts > /tmp/seo-input.json
 */
import { db } from "@/lib/db";
import { products, skus as skusTable, tags as tagsTable } from "@/modules/catalog/schema";
import { curatedAttrsFromTags } from "@/modules/catalog/lib/curated-attributes";
import { eq } from "drizzle-orm";

const FORBIDDEN = [
  "ray-ban", "rayban", "ray ban", "persol", "oakley", "gucci", "prada",
  "dior", "tom ford", "celine", "saint laurent", "ysl", "versace",
  "chanel", "miu miu", "fendi", "balenciaga", "bottega", "maui jim",
  "warby parker", "quay", "wayfarer", "clubmaster",
  "cheap", "discount", "bargain",
];

function isClean(kw: string): boolean {
  const lower = kw.toLowerCase();
  return !FORBIDDEN.some((f) => lower.includes(f));
}

async function main() {
  const all = await db.select().from(products);
  const out: unknown[] = [];

  for (const p of all.sort((a, b) => (a.skuPrefix || "").localeCompare(b.skuPrefix || ""))) {
    if (!p.skuPrefix) continue;
    const tagRows = await db.select().from(tagsTable).where(eq(tagsTable.productId, p.id));
    const skuRows = await db.select({ colorName: skusTable.colorName }).from(skusTable).where(eq(skusTable.productId, p.id));
    const curated = curatedAttrsFromTags(tagRows);

    const styleTags = tagRows
      .filter((t) => (t.dimension ?? "").toLowerCase() === "style")
      .map((t) => (t.tagName ?? "").trim())
      .filter(Boolean)
      .slice(0, 6);

    const seenKw = new Set<string>();
    const keywords: string[] = [];
    for (const t of tagRows) {
      if ((t.dimension ?? "").toLowerCase() !== "keyword") continue;
      const kw = (t.tagName ?? "").trim();
      if (!kw || seenKw.has(kw.toLowerCase())) continue;
      if (!isClean(kw)) continue;
      seenKw.add(kw.toLowerCase());
      keywords.push(kw);
    }

    const seenColor = new Set<string>();
    const colors: string[] = [];
    for (const s of skuRows) {
      if (!s.colorName) continue;
      const k = s.colorName.toLowerCase();
      if (seenColor.has(k)) continue;
      seenColor.add(k);
      colors.push(s.colorName);
    }

    out.push({
      skuPrefix: p.skuPrefix,
      name: p.name,
      productId: p.id,
      curated: {
        category: curated.category,
        frameShape: curated.frameShape,
        frameMaterial: curated.frameMaterial,
        gender: curated.gender,
        lensType: curated.lensType,
      },
      colors,
      styleTags,
      description: p.description,
      bulletPoints: p.bulletPoints,
      currentSeoTitle: p.seoTitle,
      currentMetaDescription: p.metaDescription,
      topKeywords: keywords.slice(0, 25),
    });
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
