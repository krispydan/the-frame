/**
 * Map a free-text color name (from catalog_skus.colorName, e.g. "Tortoise",
 * "Crystal Pink", "Gunmetal") to Amazon's lens_color_map / color_map enum.
 *
 * Amazon validates the literal enum string. The 20 values:
 *   Bronze, Brown, Gold, Blue, Multicolor, Black, Orange, Clear,
 *   Red, Silver, Pink, White, Metallic, Beige, Purple, Yellow,
 *   Turquoise, Green, Grey, Off White
 *
 * Strategy: keyword-first match against the canonical list, falling back
 * to "Multicolor". The AI vision pipeline can override this with a better
 * pick (see suggestedColorMap on catalog_amazon_listings) — this is the
 * deterministic baseline.
 */

const AMAZON_COLOR_MAP_ENUM = [
  "Bronze", "Brown", "Gold", "Blue", "Multicolor", "Black", "Orange", "Clear",
  "Red", "Silver", "Pink", "White", "Metallic", "Beige", "Purple", "Yellow",
  "Turquoise", "Green", "Grey", "Off White",
] as const;

export type AmazonColorMap = typeof AMAZON_COLOR_MAP_ENUM[number];

/**
 * Ordered keyword → bucket. Order matters: more specific keywords first
 * so "tortoise" matches Brown before some other token matches Multicolor.
 * Lowercase comparison; substring match.
 */
const KEYWORD_BUCKETS: Array<{ keywords: string[]; bucket: AmazonColorMap }> = [
  // Common neutral/dark
  { keywords: ["tortoise", "tort", "havana", "amber"], bucket: "Brown" },
  { keywords: ["chocolate", "coffee", "espresso", "mocha", "cognac", "tan", "brown"], bucket: "Brown" },
  { keywords: ["gunmetal", "graphite", "charcoal", "matte black", "jet"], bucket: "Black" },
  { keywords: ["black", "noir", "onyx"], bucket: "Black" },
  // Whites + off-whites
  { keywords: ["ivory", "cream", "off white", "off-white", "eggshell", "bone"], bucket: "Off White" },
  { keywords: ["white", "snow", "milk"], bucket: "White" },
  // Greys
  { keywords: ["grey", "gray", "smoke", "ash", "slate", "fog"], bucket: "Grey" },
  // Beiges / neutrals
  { keywords: ["beige", "nude", "champagne", "sand", "khaki", "taupe"], bucket: "Beige" },
  // Metallics
  { keywords: ["gold", "rose gold", "champagne gold"], bucket: "Gold" },
  { keywords: ["silver", "chrome", "platinum"], bucket: "Silver" },
  { keywords: ["bronze", "copper"], bucket: "Bronze" },
  { keywords: ["metallic", "metal"], bucket: "Metallic" },
  // Cool palette
  { keywords: ["navy", "cobalt", "indigo", "sapphire", "blue"], bucket: "Blue" },
  { keywords: ["turquoise", "teal", "aqua"], bucket: "Turquoise" },
  { keywords: ["mint", "olive", "emerald", "forest", "lime", "sage", "green"], bucket: "Green" },
  { keywords: ["lavender", "lilac", "violet", "plum", "purple"], bucket: "Purple" },
  // Warm palette
  { keywords: ["coral", "salmon", "blush", "rose", "fuchsia", "magenta", "hot pink", "pink"], bucket: "Pink" },
  { keywords: ["crimson", "burgundy", "wine", "merlot", "red"], bucket: "Red" },
  { keywords: ["peach", "rust", "tangerine", "orange"], bucket: "Orange" },
  { keywords: ["mustard", "lemon", "yellow"], bucket: "Yellow" },
  // Transparent
  { keywords: ["clear", "transparent", "crystal"], bucket: "Clear" },
  // Composite / patterned
  { keywords: ["rainbow", "multi", "tie-dye", "tie dye", "leopard", "marble"], bucket: "Multicolor" },
];

/**
 * Resolve a freeform color name into an Amazon color_map enum value.
 * Returns "Multicolor" as the safe fallback when nothing matches — that's
 * Amazon's intended catch-all and avoids blocking the listing on a
 * color we couldn't confidently classify.
 */
export function mapAmazonColor(input: string | null | undefined): AmazonColorMap {
  if (!input) return "Multicolor";
  const lower = input.toLowerCase();
  for (const { keywords, bucket } of KEYWORD_BUCKETS) {
    if (keywords.some((k) => lower.includes(k))) return bucket;
  }
  return "Multicolor";
}

/** Exposed for tests + the validator's enum guard. */
export const AMAZON_COLOR_MAP_VALUES: readonly AmazonColorMap[] = AMAZON_COLOR_MAP_ENUM;
