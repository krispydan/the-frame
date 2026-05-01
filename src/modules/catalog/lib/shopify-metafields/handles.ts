/**
 * Shopify taxonomy handle enums and validators.
 *
 * These are the valid metaobject handles for Shopify's standard taxonomy
 * fields that we populate on every Jaxy product. They're hardcoded here for
 * AI prompt constraints and validation — the sync layer then resolves them
 * to per-store GIDs via `resolveMetaobjectHandle`.
 *
 * Source: Shopify's standard taxonomy (aa-2-27 = Sunglasses). If Shopify
 * adds new handles we need, add them here AND verify they resolve on every
 * store before deploying.
 */

// ── Taxonomy target ──

export const SUNGLASSES_CATEGORY_GID = "gid://shopify/TaxonomyCategory/aa-2-27";

// ── Metaobject types ──

export const METAOBJECT_TYPES = {
  colorPattern: "shopify--color-pattern",
  ageGroup: "shopify--age-group",
  lensPolarization: "shopify--lens-polarization",
  targetGender: "shopify--target-gender",
  eyewearFrameDesign: "shopify--eyewear-frame-design",
} as const;

// ── Metafield field definitions ──

export interface CategoryMetafieldDef {
  /** Metafield key */
  key: string;
  /** Metafield namespace — all category metafields live under "shopify" */
  namespace: "shopify";
  /** Metafield type — all 7 category metafields are list.metaobject_reference */
  type: "list.metaobject_reference";
  /** Target metaobject type (handles resolve against this) */
  metaobjectType: string;
  /** Whether multi-value is allowed (all are lists, but cardinality differs) */
  multiValue: boolean;
  /** Human description for docs/logging */
  label: string;
}

export const CATEGORY_METAFIELDS: Record<string, CategoryMetafieldDef> = {
  color_pattern: {
    key: "color-pattern",
    namespace: "shopify",
    type: "list.metaobject_reference",
    metaobjectType: METAOBJECT_TYPES.colorPattern,
    multiValue: true,
    label: "Color",
  },
  eyewear_frame_color: {
    key: "eyewear-frame-color",
    namespace: "shopify",
    type: "list.metaobject_reference",
    metaobjectType: METAOBJECT_TYPES.colorPattern,
    multiValue: true,
    label: "Eyewear frame color",
  },
  lens_color: {
    key: "lens-color",
    namespace: "shopify",
    type: "list.metaobject_reference",
    metaobjectType: METAOBJECT_TYPES.colorPattern,
    multiValue: true,
    label: "Lens color",
  },
  age_group: {
    key: "age-group",
    namespace: "shopify",
    type: "list.metaobject_reference",
    metaobjectType: METAOBJECT_TYPES.ageGroup,
    multiValue: false,
    label: "Age group",
  },
  lens_polarization: {
    key: "lens-polarization",
    namespace: "shopify",
    type: "list.metaobject_reference",
    metaobjectType: METAOBJECT_TYPES.lensPolarization,
    multiValue: false,
    label: "Lens polarization",
  },
  target_gender: {
    key: "target-gender",
    namespace: "shopify",
    type: "list.metaobject_reference",
    metaobjectType: METAOBJECT_TYPES.targetGender,
    multiValue: false,
    label: "Target gender",
  },
  eyewear_frame_design: {
    key: "eyewear-frame-design",
    namespace: "shopify",
    type: "list.metaobject_reference",
    metaobjectType: METAOBJECT_TYPES.eyewearFrameDesign,
    multiValue: false,
    label: "Eyewear frame design",
  },
};

// ── Valid handle enums ──
//
// We constrain the AI to only emit handles from these lists. Anything outside
// is rejected in validation and logged. If Shopify introduces new taxonomy
// values we want to support, add them here.

export const COLOR_PATTERN_HANDLES = [
  "black",
  "white",
  "grey",
  "brown",
  "beige",
  "tan",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "navy",
  "purple",
  "pink",
  "gold",
  "silver",
  "rose-gold",
  "bronze",
  "copper",
  "clear",
  "multicolor",
  // Note: "tortoise" intentionally NOT included — neither retail nor wholesale
  // store has it seeded and we won't add it. Tortoise variants map to "brown".
] as const;
export type ColorPatternHandle = (typeof COLOR_PATTERN_HANDLES)[number];

export const AGE_GROUP_HANDLES = [
  "newborn",
  "infants",
  "toddlers",
  "kids",
  "teens-and-young-adults",
  "adults",
  "all-ages",
  "universal",
] as const;
export type AgeGroupHandle = (typeof AGE_GROUP_HANDLES)[number];

// Two stores diverged here: retail uses a custom entry with handle "uv400",
// wholesale uses the standard "non-polarized" with display renamed to "UV400".
// Both lists are valid; the sync tries them in order and writes whichever
// resolves first per store. See LENS_NON_POLARIZED_FALLBACKS in sync-from-tags.
export const LENS_POLARIZATION_HANDLES = ["polarized", "uv400", "non-polarized"] as const;
export type LensPolarizationHandle = (typeof LENS_POLARIZATION_HANDLES)[number];

export const TARGET_GENDER_HANDLES = [
  "female",
  "male",
  "unisex",
  "non-binary",
] as const;
export type TargetGenderHandle = (typeof TARGET_GENDER_HANDLES)[number];

// Shopify's actual eyewear-frame-design enum is only 6 values. Our internal
// tag vocabulary is broader (square, oval, oversized, geometric, etc.) — we
// remap those to the closest valid handle in tags-to-metafields.ts.
export const EYEWEAR_FRAME_DESIGN_HANDLES = [
  "aviator",
  "cat-eye",
  "rectangle",
  "round",
  "wayfarer",
  "other",
] as const;
export type EyewearFrameDesignHandle = (typeof EYEWEAR_FRAME_DESIGN_HANDLES)[number];

// ── AI output shape (what the categorizer returns) ──

export interface AiCategorizationOutput {
  seo: {
    title: string;
    description: string;
  };
  category_metafields: {
    color_pattern: ColorPatternHandle[];
    eyewear_frame_color: ColorPatternHandle[];
    lens_color: ColorPatternHandle[];
    age_group: AgeGroupHandle;
    lens_polarization: LensPolarizationHandle;
    target_gender: TargetGenderHandle;
    eyewear_frame_design: EyewearFrameDesignHandle;
  };
}

// ── Validators ──

function includesNarrow<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

export interface ValidationProblem {
  field: string;
  message: string;
}

/**
 * Validate a raw object against the AI output shape. Returns the narrowed
 * output plus any problems encountered (ignored fields, fallback values).
 * Non-fatal problems are logged but don't block the sync — we still emit
 * whatever fields DID validate.
 */
export function validateAiCategorization(raw: unknown): {
  output: AiCategorizationOutput | null;
  problems: ValidationProblem[];
} {
  const problems: ValidationProblem[] = [];
  if (!raw || typeof raw !== "object") {
    return { output: null, problems: [{ field: "root", message: "not an object" }] };
  }
  const r = raw as Record<string, unknown>;
  const seo = r.seo as Record<string, unknown> | undefined;
  const cm = r.category_metafields as Record<string, unknown> | undefined;

  if (!seo || typeof seo !== "object") {
    return { output: null, problems: [{ field: "seo", message: "missing" }] };
  }
  if (!cm || typeof cm !== "object") {
    return { output: null, problems: [{ field: "category_metafields", message: "missing" }] };
  }

  // SEO
  const title = typeof seo.title === "string" ? seo.title.trim() : "";
  const description = typeof seo.description === "string" ? seo.description.trim() : "";
  if (!title) problems.push({ field: "seo.title", message: "empty" });
  if (!description) problems.push({ field: "seo.description", message: "empty" });

  // Color list fields — filter to valid handles
  const filterColors = (field: string, v: unknown): ColorPatternHandle[] => {
    if (!Array.isArray(v)) {
      problems.push({ field, message: "not an array" });
      return [];
    }
    const out: ColorPatternHandle[] = [];
    for (const item of v) {
      if (includesNarrow(COLOR_PATTERN_HANDLES, item)) out.push(item);
      else problems.push({ field, message: `dropped invalid handle "${item}"` });
    }
    return out;
  };

  const color_pattern = filterColors("category_metafields.color_pattern", cm.color_pattern);
  const eyewear_frame_color = filterColors("category_metafields.eyewear_frame_color", cm.eyewear_frame_color);
  const lens_color = filterColors("category_metafields.lens_color", cm.lens_color);

  // Scalar fields — require a valid handle, fall back to safe default
  const age_group = includesNarrow(AGE_GROUP_HANDLES, cm.age_group) ? cm.age_group : (problems.push({ field: "category_metafields.age_group", message: `invalid "${cm.age_group}", defaulting to "adults"` }), "adults" as const);

  const lens_polarization = includesNarrow(LENS_POLARIZATION_HANDLES, cm.lens_polarization) ? cm.lens_polarization : (problems.push({ field: "category_metafields.lens_polarization", message: `invalid "${cm.lens_polarization}", defaulting to "non-polarized"` }), "non-polarized" as const);

  const target_gender = includesNarrow(TARGET_GENDER_HANDLES, cm.target_gender) ? cm.target_gender : (problems.push({ field: "category_metafields.target_gender", message: `invalid "${cm.target_gender}", defaulting to "unisex"` }), "unisex" as const);

  const eyewear_frame_design = includesNarrow(EYEWEAR_FRAME_DESIGN_HANDLES, cm.eyewear_frame_design) ? cm.eyewear_frame_design : (problems.push({ field: "category_metafields.eyewear_frame_design", message: `invalid "${cm.eyewear_frame_design}", defaulting to "other"` }), "other" as const);

  return {
    output: {
      seo: { title, description },
      category_metafields: {
        color_pattern,
        eyewear_frame_color,
        lens_color,
        age_group,
        lens_polarization,
        target_gender,
        eyewear_frame_design,
      },
    },
    problems,
  };
}
