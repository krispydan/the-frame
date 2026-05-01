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
  style: ["classic", "vintage", "contemporary", "retro", "casual"],
  seasonal: ["Summer 2026", "Fall 2026"],
  productType: ["sunglasses", "optical", "reading"],
  gender: ["womens", "mens", "unisex"],
  frameShape: [
    "aviator", "cat-eye", "rectangle", "round", "square",
    "oval", "oversized", "geometric", "butterfly", "wayfarer",
  ],
  materialFrame: ["acetate", "metal", "plastic", "wood"],
};
