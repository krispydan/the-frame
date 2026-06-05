/**
 * Pre-defined tag values per dimension, shown as quick-add buttons
 * in the tag management UI. Keeps tag vocabulary consistent across
 * the catalog and reduces typos from free-text entry.
 *
 * Keys must match the canonical dimension names in catalog_tags
 * (camelCase). Snake-case keys would render as a separate dimension
 * and break the curated/Shopify sync pipeline.
 */
export const TAG_PRESETS: Record<string, string[]> = {
  lens: ["polarized", "uv400"],
  // `style` carries both brand-voice tone (classic/contemporary) AND era
  // signals (vintage/70s/90s/y2k) per the Shopify SEO sync brief — the
  // deterministic SEO title formula maps these to the leading style
  // modifier ("Vintage Round Sunglasses…", "Oversized Square…"). Keep
  // them in one dimension so a single tag carries the full vibe.
  style: [
    "classic", "vintage", "contemporary", "retro", "casual",
    "70s", "90s", "y2k", "oversized", "slim",
  ],
  seasonal: ["Summer 2026", "Fall 2026"],
  productType: ["sunglasses", "optical", "reading"],
  gender: ["womens", "mens", "unisex"],
  // Note: `wayfarer` retained as a tag value for catalog hygiene only —
  // never emitted in user-facing copy (Ray-Ban trademark). The Shopify
  // sync's SEO builders map it to "Square" + style="vintage".
  frameShape: [
    "aviator", "cat-eye", "rectangle", "round", "square",
    "oval", "oversized", "geometric", "butterfly", "wayfarer",
    "hexagonal",
  ],
  materialFrame: ["acetate", "metal", "plastic", "wood"],
};
