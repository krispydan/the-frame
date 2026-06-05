/**
 * Extended metafields for the Shopify SEO sync (Phase 4).
 *
 * The existing `sync.ts` writes 9 metafields driven by AI categorization.
 * `dimensions.ts` writes 6 number_integer dimensions. This module adds
 * the rest of the field set the brief calls out:
 *
 *   - global.title_tag          (deterministic from buildSeoTitle)
 *   - global.description_tag    (deterministic from buildSeoDescription)
 *   - global.custom_label_0     ← shape (Aviator / Square / Round / …)
 *   - global.custom_label_1     ← style era (vintage / retro / oversized / …)
 *   - global.custom_label_2     ← gender (women / men / unisex)
 *   - global.custom_label_3     ← price tier (under_30 / 30_50 / 50_plus)
 *   - global.custom_label_4     ← collection batch (SS26 / FW26 / …)
 *   - custom.style_era          (era tag joined comma-list)
 *   - custom.collection_batch   (products.collection_batch)
 *
 * Frame dimensions (custom.lens_width, custom.frame_height, etc.) are
 * still written by `dimensions.ts` — we don't duplicate that work.
 *
 * The function is pure: takes a `ProductForExtendedMetafields` snapshot
 * + a productGid, returns the metafield input array. Callers append it
 * to whatever they're already pushing and submit a single combined
 * metafieldsSet mutation.
 */

import type { MetafieldsSetInput } from "@/modules/orders/lib/shopify-api";
import {
  buildSeoTitle,
  buildSeoDescription,
  type SeoBuilderContext,
} from "@/modules/catalog/lib/prompt-engine";

/** What the caller pulls out of catalog_products + curated tags + skus
 *  to feed this builder. Pure data — no DB handles. */
export interface ProductForExtendedMetafields {
  /** Required for the SEO title formula. */
  productName: string;
  /** Curated single-value frame shape (lower-case canonical: round,
   *  square, "cat-eye", aviator, etc.). May be null — the builders
   *  degrade gracefully. */
  frameShape: string | null;
  /** All style tag values for the product (lower-case). Used to pick
   *  the SEO title's leading modifier AND to populate
   *  custom.style_era / global.custom_label_1. */
  styleTags: string[];
  /** Curated target gender — "womens" / "mens" / "unisex" / null. */
  gender: string | null;
  /** Curated frame material — for the SEO description ("...with
   *  tortoise acetate..."). */
  frameMaterial?: string | null;
  /** Single dominant frame color, when one exists. Multi-color frames
   *  → null (the description template skips the color clause). */
  frameColor?: string | null;
  /** "polarized" / "uv400" — drives both the description Features list
   *  and the brand-voice line. */
  lensType?: string | null;
  /** Marketing-authored description (raw text, possibly multi-
   *  paragraph). buildBodyHtml splits it into <p> tags. */
  description?: string | null;
  /** Campaign-batch label for global.custom_label_4. Phase 1 column. */
  collectionBatch?: string | null;
  /** Retail price in dollars — drives the global.custom_label_3 price
   *  tier (under_30 / 30_50 / 50_plus). Optional; missing → no tier. */
  retailPrice?: number | null;
}

const NAMESPACE_GLOBAL = "global";
const NAMESPACE_CUSTOM = "custom";

/** Style tag values that count as ERA markers (vs brand-voice markers).
 *  The SEO Title builder already prioritises these; here we use the
 *  same list to populate custom.style_era + custom_label_1. */
const ERA_TAGS = new Set([
  "vintage", "retro", "70s", "80s", "90s", "y2k",
  "oversized", "slim", "classic",
]);

/** Price tier mapping for global.custom_label_3.
 *  Brief: <$30 → "under_30", $30–$50 → "30_50", >$50 → "50_plus". */
function priceTier(price: number | null | undefined): string | null {
  if (price == null || price <= 0) return null;
  if (price < 30) return "under_30";
  if (price < 50) return "30_50";
  return "50_plus";
}

/** Pull era tags out of the full style-tag list, in priority order.
 *  Returns comma-joined for custom.style_era (e.g. "oversized,vintage"). */
function extractEraTags(styleTags: ReadonlyArray<string>): string[] {
  const lower = styleTags.map((s) => s.toLowerCase().trim());
  return lower.filter((t) => ERA_TAGS.has(t));
}

/** Title-case the curated frame shape for use in custom_label_0
 *  ("Aviator" / "Cat Eye" / "Hexagonal"). Same mapping as the SEO title
 *  builder's title-case logic, lifted to keep this module pure. */
function shapeForLabel(shape: string | null): string | null {
  if (!shape) return null;
  const k = shape.toLowerCase().trim();
  const map: Record<string, string> = {
    round: "Round", square: "Square", rectangle: "Rectangle",
    oval: "Oval", "cat-eye": "Cat Eye", cateye: "Cat Eye",
    aviator: "Aviator", hexagonal: "Hexagonal",
    oversized: "Oversized", geometric: "Geometric",
    butterfly: "Butterfly",
    wayfarer: "Square", // TM scrub
  };
  return map[k] ?? (k[0].toUpperCase() + k.slice(1));
}

/** Title-case a gender value for custom_label_2.
 *  Empty/null → "Unisex" so Google Shopping has a non-null label. */
function genderForLabel(gender: string | null | undefined): string {
  const g = (gender ?? "").toLowerCase().trim();
  if (g === "womens" || g === "women" || g === "female") return "Women";
  if (g === "mens" || g === "men" || g === "male") return "Men";
  return "Unisex";
}

/**
 * Build the extended metafield set (SEO + custom labels + era +
 * collection batch). Returns an array ready to append to an existing
 * metafieldsSet input list.
 */
export function buildExtendedMetafields(
  productGid: string,
  p: ProductForExtendedMetafields,
): MetafieldsSetInput[] {
  const seoCtx: SeoBuilderContext = {
    productName: p.productName,
    frameShape: p.frameShape,
    styleTags: p.styleTags,
    gender: p.gender,
    frameColor: p.frameColor,
    frameMaterial: p.frameMaterial,
    lensType: p.lensType,
    description: p.description,
  };

  const out: MetafieldsSetInput[] = [];

  // ── Deterministic SEO ──
  const seoTitle = buildSeoTitle(seoCtx);
  out.push({
    ownerId: productGid,
    namespace: NAMESPACE_GLOBAL,
    key: "title_tag",
    type: "single_line_text_field",
    value: seoTitle,
  });

  const seoDescription = buildSeoDescription(seoCtx);
  out.push({
    ownerId: productGid,
    namespace: NAMESPACE_GLOBAL,
    key: "description_tag",
    type: "multi_line_text_field",
    value: seoDescription,
  });

  // ── Custom Labels 0–4 ──
  // Brief §6 mapping.

  const label0 = shapeForLabel(p.frameShape);
  if (label0) {
    out.push({
      ownerId: productGid,
      namespace: NAMESPACE_GLOBAL,
      key: "custom_label_0",
      type: "single_line_text_field",
      value: label0,
    });
  }

  const eraTags = extractEraTags(p.styleTags);
  if (eraTags.length > 0) {
    out.push({
      ownerId: productGid,
      namespace: NAMESPACE_GLOBAL,
      key: "custom_label_1",
      type: "single_line_text_field",
      value: eraTags[0], // primary era for ads
    });
  }

  out.push({
    ownerId: productGid,
    namespace: NAMESPACE_GLOBAL,
    key: "custom_label_2",
    type: "single_line_text_field",
    value: genderForLabel(p.gender),
  });

  const tier = priceTier(p.retailPrice);
  if (tier) {
    out.push({
      ownerId: productGid,
      namespace: NAMESPACE_GLOBAL,
      key: "custom_label_3",
      type: "single_line_text_field",
      value: tier,
    });
  }

  if (p.collectionBatch) {
    out.push({
      ownerId: productGid,
      namespace: NAMESPACE_GLOBAL,
      key: "custom_label_4",
      type: "single_line_text_field",
      value: p.collectionBatch,
    });
  }

  // ── custom.style_era (multi-value comma list for storefront use) ──
  if (eraTags.length > 0) {
    out.push({
      ownerId: productGid,
      namespace: NAMESPACE_CUSTOM,
      key: "style_era",
      type: "single_line_text_field",
      value: eraTags.join(","),
    });
  }

  // ── custom.collection_batch (mirror of label_4 in custom namespace
  // for storefront templating) ──
  if (p.collectionBatch) {
    out.push({
      ownerId: productGid,
      namespace: NAMESPACE_CUSTOM,
      key: "collection_batch",
      type: "single_line_text_field",
      value: p.collectionBatch,
    });
  }

  return out;
}
