/**
 * Product video coverage — what footage does each parent product have?
 *
 * The product-video programme (one video per parent frame for Shopify /
 * Faire / social) is only tractable because every clip is tagged to the
 * product it shows. This turns that tagging into a per-product report:
 * how many clips, which video types, does it have a real PRODUCT SHOT,
 * and therefore can we generate its video today.
 *
 * Grading (see MIN_* below):
 *   ready       — has ≥1 product-shot clip and enough total footage
 *   thin        — tagged, but no product shot (or too little footage)
 *   no_footage  — nothing tagged to it at all
 *
 * "Product shot" comes from the category's operator-owned is_product_shot
 * flag (see P1), NOT a hardcoded slug list.
 */
import { sqlite } from "@/lib/db";

/** A product needs at least this many seconds of usable footage. */
export const MIN_TOTAL_SEC = 6;
/** …across at least this many clips (a single clip isn't an edit). */
export const MIN_CLIPS = 2;

export type CoverageStatus = "ready" | "thin" | "no_footage";

export interface ProductCoverage {
  productId: string;
  productName: string;
  skuPrefix: string | null;
  /** Ready clips tagged to any of this product's SKUs. */
  clipCount: number;
  /** Of those, how many are a product shot (glasses on screen). */
  productShotCount: number;
  totalSec: number;
  /** Clip counts per video type, richest first. */
  byType: Array<{ slug: string; name: string; count: number; isProductShot: boolean }>;
  status: CoverageStatus;
  /** Plain-language next action for this product. */
  gap: string | null;
}

export interface CoverageSummary {
  totalProducts: number;
  ready: number;
  thin: number;
  noFootage: number;
  /** True when no category is flagged as a product shot yet (P1 not curated). */
  productShotFlagMissing: boolean;
  products: ProductCoverage[];
}

interface Row {
  productId: string;
  productName: string;
  skuPrefix: string | null;
  clipId: string | null;
  durationSec: number | null;
  categorySlug: string | null;
  categoryName: string | null;
  isProductShot: number | null;
}

/**
 * Build the coverage report for every parent product.
 * One query + in-memory grouping — cheap enough to compute on request
 * (115 products × a few hundred clips).
 */
export function buildProductCoverage(): CoverageSummary {
  const flagged = (sqlite
    .prepare(`SELECT COUNT(*) AS n FROM marketing_video_clip_categories WHERE is_product_shot = 1`)
    .get() as { n: number }).n;

  // LEFT JOINs so products with zero footage still appear — those are the
  // whole point of the report.
  const rows = sqlite.prepare(`
    SELECT p.id            AS productId,
           p.name          AS productName,
           p.sku_prefix    AS skuPrefix,
           c.id            AS clipId,
           c.duration_sec  AS durationSec,
           cat.slug        AS categorySlug,
           cat.name        AS categoryName,
           cat.is_product_shot AS isProductShot
      FROM catalog_products p
      LEFT JOIN catalog_skus s               ON s.product_id = p.id
      LEFT JOIN marketing_video_clip_products cp ON cp.sku_id = s.id
      LEFT JOIN marketing_video_clips c      ON c.id = cp.clip_id AND c.status = 'ready'
      LEFT JOIN marketing_video_clip_categories cat ON cat.id = c.category_id
     ORDER BY p.name COLLATE NOCASE
  `).all() as Row[];

  const byProduct = new Map<string, ProductCoverage & { _clipIds: Set<string>; _types: Map<string, { name: string; count: number; isProductShot: boolean }> }>();

  for (const r of rows) {
    let entry = byProduct.get(r.productId);
    if (!entry) {
      entry = {
        productId: r.productId,
        productName: r.productName,
        skuPrefix: r.skuPrefix,
        clipCount: 0,
        productShotCount: 0,
        totalSec: 0,
        byType: [],
        status: "no_footage",
        gap: null,
        _clipIds: new Set(),
        _types: new Map(),
      };
      byProduct.set(r.productId, entry);
    }
    if (!r.clipId) continue;
    // A clip tagged to two colorways of the same product joins twice —
    // count it once.
    if (entry._clipIds.has(r.clipId)) continue;
    entry._clipIds.add(r.clipId);

    const isShot = flagged > 0 ? r.isProductShot === 1 : legacyIsProductShot(r.categorySlug);
    entry.clipCount++;
    entry.totalSec += r.durationSec ?? 0;
    if (isShot) entry.productShotCount++;

    const slug = r.categorySlug ?? "uncategorized";
    const t = entry._types.get(slug) ?? { name: r.categoryName ?? "Uncategorized", count: 0, isProductShot: isShot };
    t.count++;
    entry._types.set(slug, t);
  }

  const products: ProductCoverage[] = [];
  for (const e of byProduct.values()) {
    const { _clipIds, _types, ...pub } = e;
    pub.byType = [..._types.entries()]
      .map(([slug, t]) => ({ slug, name: t.name, count: t.count, isProductShot: t.isProductShot }))
      .sort((a, b) => b.count - a.count);
    pub.totalSec = Math.round(pub.totalSec * 10) / 10;

    if (pub.clipCount === 0) {
      pub.status = "no_footage";
      pub.gap = "No clips tagged — needs filming.";
    } else if (pub.productShotCount === 0) {
      pub.status = "thin";
      pub.gap = "No clip actually shows the frame — needs one product shot.";
    } else if (pub.clipCount < MIN_CLIPS || pub.totalSec < MIN_TOTAL_SEC) {
      pub.status = "thin";
      pub.gap = `Only ${pub.clipCount} clip${pub.clipCount === 1 ? "" : "s"} (${pub.totalSec}s) — needs more footage.`;
    } else {
      pub.status = "ready";
      pub.gap = null;
    }
    products.push(pub);
  }

  // Worst coverage first — the report is a worklist, not a leaderboard.
  const order: Record<CoverageStatus, number> = { ready: 2, thin: 1, no_footage: 0 };
  products.sort((a, b) => order[a.status] - order[b.status] || a.productName.localeCompare(b.productName));

  return {
    totalProducts: products.length,
    ready: products.filter((p) => p.status === "ready").length,
    thin: products.filter((p) => p.status === "thin").length,
    noFootage: products.filter((p) => p.status === "no_footage").length,
    productShotFlagMissing: flagged === 0,
    products,
  };
}

/** Mirror of the composer's fallback when no category is flagged yet. */
function legacyIsProductShot(slug: string | null): boolean {
  return slug ? ["flat_lay", "on_model", "detail", "lifestyle", "in_car"].includes(slug) : false;
}
