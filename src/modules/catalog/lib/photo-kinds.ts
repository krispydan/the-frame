/**
 * Product-photo taxonomy — the single source of truth for what kinds of
 * product images exist, what they're named, and which platforms consume
 * them. Mirrors the Drive pipeline (docs: IMAGE-PIPELINE.md in the
 * product-images Drive folder) so files named canonically route
 * themselves on upload with zero manual mapping.
 *
 * Storage model (matches existing catalog semantics — do not invent a
 * parallel one): the KIND lives in catalog_images.source (the tag the
 * MCP upload tool already writes: white_bg, square, google_hero, …) and
 * the ANGLE lives in catalog_image_types via image_type_id (slugs:
 * front, side, top, inside, …). This file is the registry + the
 * filename parser over both.
 *
 * Two scopes:
 *   sku      — one file per colourway (JX1016-S-BLK…): the processing
 *              stages original → no_bg → white_bg → cropped → square,
 *              plus the per-colourway google hero.
 *   product  — one file per style (JX4011_case.png…): the Amazon
 *              listing set, the collection composite, lifestyle shots.
 *
 * Canonical names:
 *   {SKU}[-ANGLE]_{SUFFIX}.{ext}     sku-scope   (JX1019-R-BLK-SIDE_SQUARE_F8F9FA.jpg)
 *   {STYLE}_{SUFFIX}.{ext}           product     (JX4011_collage.png)
 *   {SKU}_google.{ext}               sku-scope   (JX4011-BLK_google.png)
 *   {SKU}.{ext}                      sku-scope   original (bare)
 * Angle is FRONT when absent. Legacy suffixes (_NOBG, _WHITEBG_SQUARE…)
 * are parsed and mapped to their canonical kind.
 */

export type PhotoScope = "sku" | "product";

export interface PhotoKind {
  slug: string;
  /** Canonical filename suffix (without extension), e.g. "SQUARE_F8F9FA". */
  suffix: string | null;
  scope: PhotoScope;
  label: string;
  description: string;
  /** Where this asset ends up. */
  platforms: Array<"shopify" | "amazon" | "faire" | "google" | "internal">;
  /** Counts toward per-SKU completeness on the coverage matrix. */
  required: boolean;
}

export const PHOTO_KINDS: PhotoKind[] = [
  { slug: "original", suffix: null, scope: "sku", label: "Original", description: "Raw source photo, any background", platforms: ["internal"], required: true },
  { slug: "no_bg", suffix: "NO_BG", scope: "sku", label: "No background", description: "Background removed, alpha preserved (PNG)", platforms: ["internal"], required: true },
  { slug: "white_bg", suffix: "WHITE_BG", scope: "sku", label: "White bg", description: "#FFFFFF composite — Amazon main-image compliant", platforms: ["amazon"], required: false },
  { slug: "cropped", suffix: "CROPPED", scope: "sku", label: "Cropped", description: "Tight content-bbox crop, alpha preserved", platforms: ["internal"], required: false },
  { slug: "square", suffix: "SQUARE_F8F9FA", scope: "sku", label: "Square #F8F9FA", description: "FINAL 2048×2048 on #F8F9FA — what Shopify + Faire get", platforms: ["shopify", "faire"], required: true },
  { slug: "google_hero", suffix: "google", scope: "sku", label: "Google hero", description: "Google Shopping hero image", platforms: ["google"], required: false },
  { slug: "lifestyle", suffix: "lifestyle", scope: "sku", label: "Lifestyle", description: "On-model / scene shot — excluded from the processing pipeline", platforms: ["shopify", "amazon", "faire"], required: false },
  // ── product-scope (Amazon listing set + composites) ──
  { slug: "case", suffix: "case", scope: "product", label: "Case", description: "Case/packaging shot (Amazon listing)", platforms: ["amazon"], required: false },
  { slug: "collage", suffix: "collage", scope: "product", label: "Collage", description: "Feature collage (Amazon listing)", platforms: ["amazon"], required: false },
  { slug: "lens", suffix: "lens", scope: "product", label: "Lens", description: "Lens feature callout (Amazon listing)", platforms: ["amazon"], required: false },
  { slug: "materials", suffix: "materials", scope: "product", label: "Materials", description: "Materials feature callout (Amazon listing)", platforms: ["amazon"], required: false },
  { slug: "dimensions", suffix: "dimensions", scope: "product", label: "Dimensions", description: "Dimensions diagram (Amazon listing)", platforms: ["amazon"], required: false },
  { slug: "collection", suffix: "collection", scope: "product", label: "Collection", description: "All-colourways composite", platforms: ["shopify", "faire"], required: false },
];

const BY_SLUG = new Map(PHOTO_KINDS.map((k) => [k.slug, k]));
export function getPhotoKind(slug: string): PhotoKind | null {
  return BY_SLUG.get(slug) ?? null;
}

/**
 * Camera angles: the filename infix (upper) → the existing
 * catalog_image_types slug it stores as. The slugs predate this file
 * (front|side|other-side|top|inside|crossed|back-crossed|name|closed|
 * above) — extend the map, not the slug spelling.
 */
export const ANGLE_TO_TYPE_SLUG: Record<string, string> = {
  FRONT: "front",
  SIDE: "side",
  OTHERSIDE: "other-side",
  TOP: "top",
  INSIDE: "inside",
  CROSSED: "crossed",
  BACKCROSSED: "back-crossed",
  NAME: "name",
  CLOSED: "closed",
  ABOVE: "above",
  BACK: "back",
  FOLDED: "folded",
  WORN: "worn",
};
export const PHOTO_ANGLES = Object.keys(ANGLE_TO_TYPE_SLUG);

export interface ParsedPhotoName {
  /** 'JX1019-R-BLK' — exactly as written (SKU generation preserved). */
  sku: string | null;
  /** 'JX4011' — always present when the name parses at all. */
  styleCode: string;
  kind: string;
  /** Only meaningful for sku-scope kinds. */
  angle: string;
  scope: PhotoScope;
}

// Legacy → canonical kind (archive naming from older pipeline runs).
const LEGACY_SUFFIXES: Record<string, string> = {
  NOBG: "no_bg",
  WHITEBG_SQUARE: "square",
  WHITEBG_CROPPED: "cropped",
};

const SUFFIX_TO_KIND = new Map<string, string>();
for (const k of PHOTO_KINDS) {
  if (k.suffix) SUFFIX_TO_KIND.set(k.suffix.toUpperCase(), k.slug);
}
for (const [legacy, slug] of Object.entries(LEGACY_SUFFIXES)) {
  SUFFIX_TO_KIND.set(legacy, slug);
}

// JX + 4 digits, then either the current -S-/-R- generation or the
// legacy direct colour, colour = 2-6 alphanumerics.
const SKU_RE = /^(JX\d{4})(-[SR])?-([A-Z0-9]{2,6})/i;
const STYLE_RE = /^(JX\d{4})(?![\d-])/i;

/**
 * Parse a photo filename into (sku|style) + kind + angle.
 * Returns null when the name doesn't follow any known convention —
 * callers surface those for manual routing rather than guessing.
 */
export function parsePhotoFileName(fileName: string): ParsedPhotoName | null {
  const base = fileName.replace(/\.[a-z0-9]+$/i, "").trim();
  // Anything mentioning lifestyle is a lifestyle shot regardless of shape.
  const isLifestyle = /lifestyle/i.test(base);

  const skuMatch = SKU_RE.exec(base);
  if (skuMatch) {
    const sku = base.slice(0, skuMatch[0].length).toUpperCase();
    const styleCode = skuMatch[1].toUpperCase();
    let rest = base.slice(skuMatch[0].length); // '', '-SIDE_SQUARE_F8F9FA', '_google', …

    if (isLifestyle) return { sku, styleCode, kind: "lifestyle", angle: "FRONT", scope: "sku" };

    // Optional -ANGLE infix.
    let angle = "FRONT";
    const angleMatch = /^-([A-Z]+)(?=_|$)/i.exec(rest);
    if (angleMatch && (PHOTO_ANGLES as readonly string[]).includes(angleMatch[1].toUpperCase())) {
      angle = angleMatch[1].toUpperCase();
      rest = rest.slice(angleMatch[0].length);
    }

    if (rest === "") return { sku, styleCode, kind: "original", angle, scope: "sku" };
    if (rest.startsWith("_")) {
      const suffix = rest.slice(1).toUpperCase();
      const kind = SUFFIX_TO_KIND.get(suffix);
      if (kind) {
        // A SKU-named file stays sku-attached even for a nominally
        // product-scope suffix (a per-colourway collage is unusual, not wrong).
        return { sku, styleCode, kind, angle, scope: "sku" };
      }
      // Unknown suffix on a valid SKU → treat as an original variant
      // ("JX4009-BLK - FRONT - COLOR MOCKUP" style names don't parse here;
      // spaces put them in the null bucket below).
      if (/^[A-Z0-9_]+$/.test(suffix)) {
        return { sku, styleCode, kind: "original", angle, scope: "sku" };
      }
    }
    return null;
  }

  const styleMatch = STYLE_RE.exec(base);
  if (styleMatch) {
    const styleCode = styleMatch[1].toUpperCase();
    const rest = base.slice(styleMatch[0].length);
    if (isLifestyle) return { sku: null, styleCode, kind: "lifestyle", angle: "FRONT", scope: "product" };
    if (rest.startsWith("_")) {
      // collage2 → collage; case/lens/materials/dimensions/collection as-is.
      const suffix = rest.slice(1).replace(/\d+$/, "").toUpperCase();
      const kind = SUFFIX_TO_KIND.get(suffix);
      if (kind && getPhotoKind(kind)!.scope === "product") {
        return { sku: null, styleCode, kind, angle: "FRONT", scope: "product" };
      }
    }
  }
  return null;
}
