/**
 * Map the-frame's curated catalog_tags + product fields to the three
 * Shopify metafields the user wants synced from their hand-curated data:
 *
 *   lens-polarization   ← tags[dimension="lens"]  | products.lens_type
 *   eyewear-frame-design ← tags[dimension="frameShape"] | products.frame_shape
 *   target-gender       ← tags[dimension="gender"] | products.gender
 *
 * Lookups prefer tag rows when present (most recent curation) and fall
 * back to the legacy single-value columns on catalog_products.
 *
 * Returns the resolved Shopify handles plus a list of warnings so the
 * UI can show what was dropped/defaulted.
 */

import {
  EYEWEAR_FRAME_DESIGN_HANDLES,
  LENS_POLARIZATION_HANDLES,
  TARGET_GENDER_HANDLES,
  type EyewearFrameDesignHandle,
  type LensPolarizationHandle,
  type TargetGenderHandle,
} from "./handles";

export type TagInput = { dimension: string; tagName: string | null };

/**
 * Display labels for `custom.lens_type` (single_line_text_field).
 * The Shopify standard `shopify.lens-polarization` is also written
 * (metaobject ref) — these coexist for theme flexibility.
 */
export const CUSTOM_LENS_TYPE_CHOICES = ["Polarized", "UV400"] as const;
export type CustomLensTypeChoice = (typeof CUSTOM_LENS_TYPE_CHOICES)[number];

const CUSTOM_LENS_TYPE_MAP: Record<string, CustomLensTypeChoice> = {
  polarized: "Polarized",
  uv400: "UV400",
  uv: "UV400",
  "non-polarized": "UV400",
  nonpolarized: "UV400",
};

/**
 * Display labels for `custom.frame_shape` (list.single_line_text_field).
 * These match the Shopify metafield definition's `choices` validation
 * exactly — case and spacing matter. Trimmed from 10 to 6 because
 * Oval/Geometric/Butterfly/Wayfarer were rarely used and merge cleanly
 * into the kept set (see CUSTOM_FRAME_SHAPE_MAP for the redirects).
 */
export const CUSTOM_FRAME_SHAPE_CHOICES = [
  "Aviator",
  "Cat Eye",
  "Rectangle",
  "Round",
  "Square",
  "Oversized",
] as const;
export type CustomFrameShapeChoice = (typeof CUSTOM_FRAME_SHAPE_CHOICES)[number];

export type TagsToMetafieldsResult = {
  /** Shopify handles to write. Null = field has no resolvable value (skip). */
  lensPolarization: LensPolarizationHandle | null;
  eyewearFrameDesign: EyewearFrameDesignHandle | null;
  /** Full-vocab label for custom.frame_shape (single value, plain text). */
  customFrameShape: CustomFrameShapeChoice | null;
  /** Plain-text label for custom.lens_type (Polarized / UV400). */
  customLensType: CustomLensTypeChoice | null;
  targetGender: TargetGenderHandle | null;
  /** Source tag/value used per field, for debugging in the UI. */
  sources: {
    lensPolarization: string | null;
    eyewearFrameDesign: string | null;
    customFrameShape: string | null;
    customLensType: string | null;
    targetGender: string | null;
  };
  /** Non-fatal warnings — unmapped values, ambiguous tags, etc. */
  warnings: string[];
};

/**
 * Lens polarization map. The-frame's tag values aren't the same as
 * Shopify's enum (which only has polarized / non-polarized).
 */
// "uv400" is the canonical the-frame value for non-polarized lenses. The
// mapper emits handle "uv400"; sync-from-tags falls back to "non-polarized"
// (the standard taxonomy handle) on stores where "uv400" doesn't resolve.
const LENS_MAP: Record<string, LensPolarizationHandle> = {
  polarized: "polarized",
  uv400: "uv400",
  uv: "uv400",
  "non-polarized": "uv400",
  nonpolarized: "uv400",
};

/**
 * Frame design map. The-frame uses some values Shopify doesn't (browline
 * isn't in our tags but is in Shopify; cat-eye matches; etc.). Keep
 * aliases tight — drop anything we can't map confidently.
 */
// Map the-frame tag values to Shopify's 5 storefront-useful enum values
// (aviator, cat-eye, rectangle, round, wayfarer). We deliberately don't
// route anything to "other" — see the comment on EYEWEAR_FRAME_DESIGN_HANDLES
// in handles.ts. Tags without a clean fit return null from this map and
// the field is skipped on Shopify; their actual shape is still surfaced
// through the richer custom.frame_shape metafield.
const FRAME_DESIGN_MAP: Record<string, EyewearFrameDesignHandle> = {
  // Direct matches
  aviator: "aviator",
  "cat-eye": "cat-eye",
  cateye: "cat-eye",
  rectangle: "rectangle",
  rectangular: "rectangle",
  round: "round",
  wayfarer: "wayfarer",
  // Confirmed close-fit remaps
  square: "rectangle",
  oval: "round",
  butterfly: "cat-eye",
  geometric: "rectangle",
  // Tags with no useful storefront-filter equivalent are deliberately
  // omitted — products with these tags skip the standard metafield:
  //   oversized, wraparound, wrap, shield, browline, rimless
};

/**
 * Map raw frame-shape tag values to the display label used by the custom
 * `custom.frame_shape` metafield (list.single_line_text_field with 10 choices).
 * Anything that doesn't match returns null and is dropped.
 */
// Tag value (lowercase) → display label written to custom.frame_shape.
// Confirmed mappings for legacy tags not in the 6-value set:
//   oval → Round  (5 products)
//   butterfly → Cat Eye  (1 product)
//   geometric → Square  (2 products)
//   wayfarer → Rectangle  (closest visually)
// Underlying tags are preserved on the product for future re-vocabulary.
const CUSTOM_FRAME_SHAPE_MAP: Record<string, CustomFrameShapeChoice> = {
  aviator: "Aviator",
  "cat-eye": "Cat Eye",
  cateye: "Cat Eye",
  rectangle: "Rectangle",
  rectangular: "Rectangle",
  round: "Round",
  square: "Square",
  oversized: "Oversized",
  // Merged into closest neighbour
  oval: "Round",
  butterfly: "Cat Eye",
  geometric: "Square",
  wayfarer: "Rectangle",
};

/**
 * Gender map. The-frame's terms are casual ("womens"), Shopify's are
 * formal ("female").
 */
const GENDER_MAP: Record<string, TargetGenderHandle> = {
  womens: "female",
  women: "female",
  female: "female",
  ladies: "female",
  mens: "male",
  men: "male",
  male: "male",
  unisex: "unisex",
  uni: "unisex",
  nonbinary: "non-binary",
  "non-binary": "non-binary",
};

function normalize(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.trim().toLowerCase();
}

/**
 * Pick a representative tag for a single-value dimension. If multiple are
 * present, pick the first one we can map to a known Shopify handle and
 * warn about the others being ignored.
 */
function pickTagValue<T extends string>(
  tags: TagInput[],
  dimension: string,
  map: Record<string, T>,
  warnings: string[],
  fieldLabel: string,
): { value: T | null; sourceRaw: string | null } {
  // Normalize BOTH sides of the comparison. The-frame stores camelCase
  // dimension names like "frameShape" but callers pass dimension params as
  // either "frameShape" or "frame_shape"; normalize lowercases both so a
  // call with "frameShape" matches stored "frameShape" rows too.
  const wantDim = dimension.trim().toLowerCase();
  const matching = tags.filter((t) => normalize(t.dimension) === wantDim);
  if (matching.length === 0) return { value: null, sourceRaw: null };

  let chosen: { value: T; raw: string } | null = null;
  const skipped: string[] = [];
  for (const t of matching) {
    const raw = normalize(t.tagName);
    if (!raw) continue;
    const mapped = map[raw];
    if (mapped && !chosen) {
      chosen = { value: mapped, raw };
    } else if (!mapped) {
      skipped.push(raw);
    } else {
      skipped.push(raw);
    }
  }

  if (chosen && skipped.length > 0) {
    warnings.push(
      `${fieldLabel}: picked "${chosen.raw}", ignored ${skipped.length} other tag${skipped.length === 1 ? "" : "s"}: ${skipped.join(", ")}`,
    );
  }
  if (!chosen && matching.length > 0) {
    warnings.push(
      `${fieldLabel}: no usable mapping for tags [${matching.map((t) => t.tagName).join(", ")}]`,
    );
  }
  return { value: chosen?.value ?? null, sourceRaw: chosen?.raw ?? null };
}

export function mapTagsToMetafields(opts: {
  tags: TagInput[];
}): TagsToMetafieldsResult {
  const warnings: string[] = [];

  // Lens polarization — read from the `lens` tag dimension. Tags are now
  // the single source of truth (legacy products.lens_type column was dropped).
  // Resolve the SAME tag through TWO maps in parallel so the Shopify
  // standard handle and the custom-field label always agree on which tag
  // they came from (mirrors the frame-shape pattern below).
  const lensFromTags = pickTagValue(opts.tags, "lens", LENS_MAP, warnings, "lens-polarization");
  const customLensFromTags = pickTagValue(opts.tags, "lens", CUSTOM_LENS_TYPE_MAP, [], "custom.lens_type");
  let lensPolarization: LensPolarizationHandle | null = lensFromTags.value;
  let lensSource = lensFromTags.sourceRaw;
  let customLensType: CustomLensTypeChoice | null = customLensFromTags.value;
  let customLensSource = customLensFromTags.sourceRaw;

  // Eyewear frame design — `frameShape` dimension first; some legacy
  // products also have `frame_shape` (snake_case) so we accept both.
  // We resolve the SAME source tag through TWO maps in parallel so the
  // Shopify standard handle and the custom-field label always agree on which
  // tag they came from.
  const designFromTags = pickTagValue(opts.tags, "frameShape", FRAME_DESIGN_MAP, [], "eyewear-frame-design");
  const customFromTags = pickTagValue(opts.tags, "frameShape", CUSTOM_FRAME_SHAPE_MAP, [], "custom.frame_shape");
  let designLegacy = designFromTags.value;
  let designSource = designFromTags.sourceRaw;
  let customFrameShape: CustomFrameShapeChoice | null = customFromTags.value;
  let customFrameShapeSource = customFromTags.sourceRaw;
  if (!designLegacy) {
    const fallback = pickTagValue(opts.tags, "frame_shape", FRAME_DESIGN_MAP, [], "eyewear-frame-design");
    if (fallback.value) {
      designLegacy = fallback.value;
      designSource = `${fallback.sourceRaw} (frame_shape dimension)`;
    }
  }
  if (!customFrameShape) {
    const fallback = pickTagValue(opts.tags, "frame_shape", CUSTOM_FRAME_SHAPE_MAP, [], "custom.frame_shape");
    if (fallback.value) {
      customFrameShape = fallback.value;
      customFrameShapeSource = `${fallback.sourceRaw} (frame_shape dimension)`;
    }
  }
  // Surface dropped tag-row warnings ONLY when we ended up resolving (so the
  // user sees "we picked this, here's what we ignored"). Otherwise the no-mapping
  // line above already tells the story.
  if (designLegacy) {
    const matchingFs = opts.tags.filter((t) => normalize(t.dimension) === "frameShape" || normalize(t.dimension) === "frame_shape");
    const otherValues = matchingFs.map((t) => normalize(t.tagName)).filter((v): v is string => !!v && v !== designSource?.split(" ")[0]);
    if (otherValues.length > 0) {
      warnings.push(`eyewear-frame-design: picked "${designSource}", ignored ${otherValues.length} other tag${otherValues.length === 1 ? "" : "s"}: ${otherValues.join(", ")}`);
    }
  }

  // Target gender
  const genderFromTags = pickTagValue(opts.tags, "gender", GENDER_MAP, warnings, "target-gender");
  let targetGender: TargetGenderHandle | null = genderFromTags.value;
  let genderSource = genderFromTags.sourceRaw;

  // Final validation that what we picked is actually in the Shopify enum.
  // (Should always be true given the maps above, but defense in depth.)
  if (lensPolarization && !LENS_POLARIZATION_HANDLES.includes(lensPolarization)) {
    warnings.push(`lens-polarization: dropped invalid handle "${lensPolarization}"`);
    lensPolarization = null;
  }
  if (designLegacy && !EYEWEAR_FRAME_DESIGN_HANDLES.includes(designLegacy)) {
    warnings.push(`eyewear-frame-design: dropped invalid handle "${designLegacy}"`);
    designLegacy = null;
  }
  if (targetGender && !TARGET_GENDER_HANDLES.includes(targetGender)) {
    warnings.push(`target-gender: dropped invalid handle "${targetGender}"`);
    targetGender = null;
  }
  if (customFrameShape && !CUSTOM_FRAME_SHAPE_CHOICES.includes(customFrameShape)) {
    warnings.push(`custom.frame_shape: dropped invalid choice "${customFrameShape}"`);
    customFrameShape = null;
  }
  if (customLensType && !CUSTOM_LENS_TYPE_CHOICES.includes(customLensType)) {
    warnings.push(`custom.lens_type: dropped invalid choice "${customLensType}"`);
    customLensType = null;
  }

  return {
    lensPolarization,
    eyewearFrameDesign: designLegacy,
    customFrameShape,
    customLensType,
    targetGender,
    sources: {
      lensPolarization: lensSource,
      eyewearFrameDesign: designSource,
      customFrameShape: customFrameShapeSource,
      customLensType: customLensSource,
      targetGender: genderSource,
    },
    warnings,
  };
}
