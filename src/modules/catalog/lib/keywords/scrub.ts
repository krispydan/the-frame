/**
 * Centralized keyword scrub + classify for Amazon SEO.
 *
 * Helium 10 Cerebro exports are gold but noisy: ~20% competitor brand
 * terms, plus off-intent lifestyle noise ("sandals 754k", "beach
 * essentials 486k") that out-volumes the keywords we actually want to
 * rank for. This module is the single gate every imported phrase passes
 * through before it can reach a product listing.
 *
 * Pipeline (short-circuit, first match wins):
 *   normalize → junk → override → brand → irrelevant category →
 *   INTENT GATE (must name eyewear) → classify pool + shape.
 *
 * Data lives in ./data/*.json so ops can tune the block/keep lists
 * without a logic redeploy.
 *
 * Also the single source of truth for FORBIDDEN_TERMS (brands +
 * trademarks + pricing words) used by the copy-generation prompts —
 * google-shopping-prompt.ts re-exports it so existing importers keep
 * working.
 */

import brandData from "./data/brand-blocklist.json";
import irrelevantData from "./data/irrelevant-categories.json";

// ── Source lists ─────────────────────────────────────────────────────────

/** Competitor + trademarked-line names — scrubbed from keywords AND copy. */
export const BRAND_TERMS: string[] = [
  ...(brandData.trademarked_lines ?? []),
  ...(brandData.brands ?? []),
].map((t) => t.toLowerCase().trim()).filter(Boolean);

/** Pricing / quality words we never use in our own copy. Not brands, so
 *  they don't scrub a keyword (people DO search "cheap sunglasses"), but
 *  they must never appear in generated titles/bullets. */
const PRICING_WORDS = [
  "cheap",
  "discount",
  "bargain",
  "knock-off",
  "knockoff",
  "dupe",
  "imitation",
  "replica",
  "fake",
];

/**
 * Forbidden in generated copy: brands + trademarks + pricing words.
 * Re-exported by google-shopping-prompt.ts as FORBIDDEN_TERMS so the
 * Amazon + Google Shopping + SEO prompts share one list.
 */
export const FORBIDDEN_TERMS: string[] = [...BRAND_TERMS, ...PRICING_WORDS];

/** Flattened disqualifier list — wrong eyewear category, wrong audience,
 *  accessories, lifestyle noise. */
const IRRELEVANT_TERMS: string[] = [
  ...(irrelevantData.wrong_eyewear_category ?? []),
  ...(irrelevantData.wrong_audience ?? []),
  ...(irrelevantData.accessories ?? []),
  ...(irrelevantData.lifestyle_noise ?? []),
].map((t) => t.toLowerCase().trim()).filter(Boolean);

// ── Domain + shape vocabulary ────────────────────────────────────────────

/**
 * A phrase must contain at least one of these to clear the intent gate.
 * Generic shape words (round/square/oval) are intentionally NOT here —
 * they're too ambiguous alone ("round table") and always co-occur with
 * "sunglasses"/"glasses" in the real exports. "aviator"/"cat eye" ARE
 * here because they unambiguously mean eyewear.
 */
export const DOMAIN_TOKENS = [
  "sunglasses",
  "sunglass",
  "sunnies",
  "shades",
  "eyewear",
  "eyeglasses",
  "glasses",
  "spectacles",
  "specs",
  "aviator",
  "aviators",
  "cat eye",
  "cat-eye",
  "cateye",
];

/**
 * Canonical shape → its synonyms. Canonical keys match the curated
 * `frameShape` tag values (matching is whitespace/hyphen-insensitive via
 * normalizeShape, so exact casing doesn't matter at the call site).
 */
const SHAPE_SYNONYMS: Record<string, string[]> = {
  round: ["round", "circle", "circular", "john lennon"],
  "cat-eye": ["cat eye", "cat-eye", "cateye", "cats eye", "cat's eye"],
  square: ["square"],
  aviator: ["aviator", "aviators", "pilot", "teardrop"],
  oval: ["oval"],
  rectangle: ["rectangle", "rectangular", "rectangles"],
  hexagon: ["hexagon", "hexagonal", "hexagons"],
};

/** Feature tokens (shape-agnostic, shared head-pool terms). */
const FEATURE_TOKENS = [
  "polarized",
  "polarised",
  "uv400",
  "uv 400",
  "uv protection",
  "mirrored",
  "gradient",
  "photochromic",
  "tinted",
];

/** Audience tokens. */
const AUDIENCE_TOKENS = [
  "women",
  "womens",
  "woman",
  "ladies",
  "female",
  "men",
  "mens",
  "man",
  "male",
  "unisex",
];

/** Use-case / occasion tokens. */
const USE_CASE_TOKENS = [
  "driving",
  "fishing",
  "golf",
  "beach",
  "running",
  "cycling",
  "biking",
  "sport",
  "sports",
  "hiking",
  "travel",
  "festival",
  "vacation",
  "summer",
];

// ── Matching helpers ─────────────────────────────────────────────────────

/** Word-boundary test that tolerates hyphens/spaces inside the needle. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesAny(haystack: string, needles: string[]): string | null {
  for (const n of needles) {
    if (!n) continue;
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(n)}(?:$|[^a-z0-9])`, "i");
    if (re.test(haystack)) return n;
  }
  return null;
}

/**
 * Like matchesAny but tolerates a trailing plural/possessive on the brand
 * token, so "ray bans" / "raybans" / "oakley's" all match "ray ban" /
 * "rayban" / "oakley". Brand pollution is the #1 thing we must catch.
 */
function matchesBrand(haystack: string, needles: string[]): string | null {
  for (const n of needles) {
    if (!n) continue;
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(n)}(?:['’]s|s)?(?:$|[^a-z0-9])`, "i");
    if (re.test(haystack)) return n;
  }
  return null;
}

/** Normalize a shape label for matching: lowercase, strip spaces/hyphens.
 *  "Cat-Eye" / "cat eye" / "cateye" all collapse to "cateye". */
export function normalizeShape(shape: string | null | undefined): string {
  return (shape ?? "").toLowerCase().replace(/[\s_-]+/g, "");
}

/** Canonical shape keys, exposed for the importer/assembler/UI tabs. */
export const CANONICAL_SHAPES = Object.keys(SHAPE_SYNONYMS);

// ── Classification ───────────────────────────────────────────────────────

export type KeywordVerdict = "keep" | "brand" | "irrelevant" | "off_intent" | "junk";
export type KeywordPool = "head" | "shape" | "feature" | "audience" | "use_case";

export interface KeywordClassification {
  /** Normalized phrase (lowercased, collapsed whitespace). */
  phrase: string;
  verdict: KeywordVerdict;
  /** null for everything except verdict === "keep". */
  pool: KeywordPool | null;
  /** Canonical shape for shape-pool keeps; null = shared/head term. */
  shape: string | null;
  /** What triggered a non-keep verdict (audit/debug). */
  reason?: string;
}

export interface ClassifyOptions {
  /** Phrases to always keep (case-insensitive exact match after normalize). */
  whitelist?: Set<string>;
  /** Phrases to always drop. */
  blacklist?: Set<string>;
}

/**
 * Classify a single keyword phrase. Pure function — no I/O.
 */
export function classifyKeyword(
  raw: string,
  opts: ClassifyOptions = {},
): KeywordClassification {
  const phrase = (raw ?? "").toLowerCase().replace(/\s+/g, " ").trim();

  // 1. Junk — empty, too short, or no latin letters (foreign-script rows).
  if (!phrase || phrase.length < 3 || !/[a-z]/.test(phrase)) {
    return { phrase, verdict: "junk", pool: null, shape: null, reason: "empty/no-latin" };
  }

  // 2. Manual overrides win over everything.
  if (opts.blacklist?.has(phrase)) {
    return { phrase, verdict: "irrelevant", pool: null, shape: null, reason: "blacklist override" };
  }
  const whitelisted = opts.whitelist?.has(phrase) ?? false;

  if (!whitelisted) {
    // 3. Brand / trademark (plural/possessive-tolerant).
    const brand = matchesBrand(phrase, BRAND_TERMS);
    if (brand) {
      return { phrase, verdict: "brand", pool: null, shape: null, reason: `brand:${brand}` };
    }

    // 4. Irrelevant category (runs BEFORE the intent gate so
    //    "sunglasses case" / "reading glasses" are caught even though
    //    they contain a domain token).
    const irrelevant = matchesAny(phrase, IRRELEVANT_TERMS);
    if (irrelevant) {
      return { phrase, verdict: "irrelevant", pool: null, shape: null, reason: `irrelevant:${irrelevant}` };
    }

    // 5. Intent gate — must name eyewear. Kills "sandals 754k".
    if (!matchesAny(phrase, DOMAIN_TOKENS)) {
      return { phrase, verdict: "off_intent", pool: null, shape: null, reason: "no eyewear token" };
    }
  }

  // 6. Classify the survivor into a pool + shape.
  let shape: string | null = null;
  for (const [canonical, synonyms] of Object.entries(SHAPE_SYNONYMS)) {
    if (matchesAny(phrase, synonyms)) {
      shape = canonical;
      break;
    }
  }

  let pool: KeywordPool;
  if (shape) pool = "shape";
  else if (matchesAny(phrase, FEATURE_TOKENS)) pool = "feature";
  else if (matchesAny(phrase, AUDIENCE_TOKENS)) pool = "audience";
  else if (matchesAny(phrase, USE_CASE_TOKENS)) pool = "use_case";
  else pool = "head";

  return { phrase, verdict: "keep", pool, shape };
}
