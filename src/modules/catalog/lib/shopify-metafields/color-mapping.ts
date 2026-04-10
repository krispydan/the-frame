/**
 * Deterministic mapping from Jaxy color names/codes to Shopify
 * color-pattern handles. This gives the AI a strong prior: we feed it the
 * "suggested" frame color based on the variant's colorName, and the AI
 * can confirm or refine it based on the actual product image.
 *
 * SKU color codes come from the historic AJ Morgan taxonomy. Entries here
 * should be lowercase. Partial matching is OK — see normalizeColorName().
 */
import type { ColorPatternHandle } from "./handles";
import { COLOR_PATTERN_HANDLES } from "./handles";

/**
 * Color-name keyword → Shopify color-pattern handle.
 * Keys are substrings that are matched against a lowercased color name.
 * Order matters: longer / more-specific keys should come first so
 * "rose gold" beats "gold" and "dark blue" beats "blue".
 */
const COLOR_KEYWORDS: Array<[string, ColorPatternHandle]> = [
  // Multi-word / specific first
  ["rose gold", "rose-gold"],
  ["rose-gold", "rose-gold"],
  ["dark blue", "navy"],
  ["navy blue", "navy"],
  ["navy", "navy"],
  ["matte black", "black"],
  ["matte red", "red"],
  ["gun metal", "grey"],
  ["gunmetal", "grey"],
  ["champagne", "gold"],
  ["tortoise", "brown"],
  ["tortoiseshell", "brown"],
  ["havana", "brown"],
  ["leopard", "brown"],
  // Single-word generic colors
  ["black", "black"],
  ["white", "white"],
  ["grey", "grey"],
  ["gray", "grey"],
  ["silver", "silver"],
  ["gold", "gold"],
  ["bronze", "bronze"],
  ["copper", "copper"],
  ["brown", "brown"],
  ["beige", "beige"],
  ["tan", "tan"],
  ["cream", "beige"],
  ["red", "red"],
  ["orange", "orange"],
  ["yellow", "yellow"],
  ["green", "green"],
  ["blue", "blue"],
  ["purple", "purple"],
  ["pink", "pink"],
  ["clear", "clear"],
  ["crystal", "clear"],
];

/**
 * Legacy 3-letter / short SKU color code → Shopify color-pattern handle.
 * Used when colorName is empty and we only have a code like "BRW", "GLP".
 */
const CODE_MAP: Record<string, ColorPatternHandle[]> = {
  BLK: ["black"],
  WHT: ["white"],
  GRY: ["grey"],
  SLV: ["silver"],
  GLD: ["gold"],
  BRW: ["brown"],
  BRZ: ["bronze"],
  COP: ["copper"],
  BEI: ["beige"],
  TAN: ["tan"],
  RED: ["red"],
  ORG: ["orange"],
  YLW: ["yellow"],
  GRN: ["green"],
  BLU: ["blue"],
  NVY: ["navy"],
  PUR: ["purple"],
  PNK: ["pink"],
  TOR: ["brown"], // tortoise → brown
  CHA: ["gold"], // champagne → gold
  // Combinations (slash or dash separated)
  GLP: ["gold", "pink"],
  SLB: ["silver", "blue"],
  BKR: ["black", "red"],
  TRB: ["brown", "blue"],
  BKS: ["black", "silver"],
};

/**
 * Extract one or more color-pattern handles from a freeform color name or
 * short code. Returns an empty array if nothing matches — the AI is then
 * responsible for filling it in from the image.
 */
export function inferColorHandles(colorName: string | null | undefined): ColorPatternHandle[] {
  if (!colorName) return [];
  const trimmed = colorName.trim();
  if (!trimmed) return [];

  // First pass: exact code match (case-insensitive). Handles things like "BRW", "GLP".
  const upper = trimmed.toUpperCase();
  if (CODE_MAP[upper]) return [...CODE_MAP[upper]];

  // Second pass: split on common separators and try code match per token.
  // Handles "Gold/Pink", "Silver-Blue".
  const tokens = upper.split(/[\s/\-]+/).filter(Boolean);
  const codeMatches: ColorPatternHandle[] = [];
  for (const t of tokens) {
    if (CODE_MAP[t]) codeMatches.push(...CODE_MAP[t]);
  }
  if (codeMatches.length > 0) return dedupe(codeMatches);

  // Third pass: keyword substring match on the lowercased full name.
  const lower = trimmed.toLowerCase();
  const kwMatches: ColorPatternHandle[] = [];
  for (const [kw, handle] of COLOR_KEYWORDS) {
    if (lower.includes(kw) && !kwMatches.includes(handle)) {
      kwMatches.push(handle);
    }
  }
  return kwMatches;
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

/** Exposed for debugging / unit tests. */
export function _allKnownHandles(): readonly ColorPatternHandle[] {
  return COLOR_PATTERN_HANDLES;
}
