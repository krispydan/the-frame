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

export type TagsToMetafieldsResult = {
  /** Shopify handles to write. Null = field has no resolvable value (skip). */
  lensPolarization: LensPolarizationHandle | null;
  eyewearFrameDesign: EyewearFrameDesignHandle | null;
  targetGender: TargetGenderHandle | null;
  /** Source tag/value used per field, for debugging in the UI. */
  sources: {
    lensPolarization: string | null;
    eyewearFrameDesign: string | null;
    targetGender: string | null;
  };
  /** Non-fatal warnings — unmapped values, ambiguous tags, etc. */
  warnings: string[];
};

/**
 * Lens polarization map. The-frame's tag values aren't the same as
 * Shopify's enum (which only has polarized / non-polarized).
 */
const LENS_MAP: Record<string, LensPolarizationHandle> = {
  polarized: "polarized",
  uv400: "non-polarized",
  // Aliases just in case
  "non-polarized": "non-polarized",
  nonpolarized: "non-polarized",
  uv: "non-polarized",
};

/**
 * Frame design map. The-frame uses some values Shopify doesn't (browline
 * isn't in our tags but is in Shopify; cat-eye matches; etc.). Keep
 * aliases tight — drop anything we can't map confidently.
 */
const FRAME_DESIGN_MAP: Record<string, EyewearFrameDesignHandle> = {
  round: "round",
  square: "square",
  rectangle: "rectangle",
  rectangular: "rectangle",
  oval: "oval",
  aviator: "aviator",
  "cat-eye": "cat-eye",
  cateye: "cat-eye",
  wraparound: "wraparound",
  wrap: "wraparound",
  shield: "shield",
  geometric: "geometric",
  browline: "browline",
  rimless: "rimless",
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
  const matching = tags.filter((t) => normalize(t.dimension) === dimension);
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
  /** Fallback values from the legacy product-level columns. */
  fallbackLensType?: string | null;
  fallbackFrameShape?: string | null;
  fallbackGender?: string | null;
}): TagsToMetafieldsResult {
  const warnings: string[] = [];

  // Lens polarization — try `lens` dimension first (curated), then `lens_type`
  // column on the product row (single-value).
  const lensFromTags = pickTagValue(opts.tags, "lens", LENS_MAP, warnings, "lens-polarization");
  let lensPolarization: LensPolarizationHandle | null = lensFromTags.value;
  let lensSource = lensFromTags.sourceRaw;
  if (!lensPolarization && opts.fallbackLensType) {
    const raw = normalize(opts.fallbackLensType);
    if (raw && LENS_MAP[raw]) {
      lensPolarization = LENS_MAP[raw];
      lensSource = `${raw} (from products.lens_type)`;
    } else if (raw) {
      warnings.push(`lens-polarization: products.lens_type "${raw}" doesn't map to a Shopify handle`);
    }
  }

  // Eyewear frame design — `frameShape` dimension first; some legacy
  // products also have `frame_shape` (snake_case) so we accept both.
  const designFromTags = pickTagValue(opts.tags, "frameShape", FRAME_DESIGN_MAP, [], "eyewear-frame-design");
  let designLegacy = designFromTags.value;
  let designSource = designFromTags.sourceRaw;
  if (!designLegacy) {
    const fallback = pickTagValue(opts.tags, "frame_shape", FRAME_DESIGN_MAP, [], "eyewear-frame-design");
    if (fallback.value) {
      designLegacy = fallback.value;
      designSource = `${fallback.sourceRaw} (frame_shape dimension)`;
    }
  }
  if (!designLegacy && opts.fallbackFrameShape) {
    const raw = normalize(opts.fallbackFrameShape);
    if (raw && FRAME_DESIGN_MAP[raw]) {
      designLegacy = FRAME_DESIGN_MAP[raw];
      designSource = `${raw} (from products.frame_shape)`;
    } else if (raw) {
      warnings.push(`eyewear-frame-design: products.frame_shape "${raw}" doesn't map to a Shopify handle`);
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
  if (!targetGender && opts.fallbackGender) {
    const raw = normalize(opts.fallbackGender);
    if (raw && GENDER_MAP[raw]) {
      targetGender = GENDER_MAP[raw];
      genderSource = `${raw} (from products.gender)`;
    } else if (raw) {
      warnings.push(`target-gender: products.gender "${raw}" doesn't map to a Shopify handle`);
    }
  }

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

  return {
    lensPolarization,
    eyewearFrameDesign: designLegacy,
    targetGender,
    sources: {
      lensPolarization: lensSource,
      eyewearFrameDesign: designSource,
      targetGender: genderSource,
    },
    warnings,
  };
}
