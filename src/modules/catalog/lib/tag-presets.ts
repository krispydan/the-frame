/**
 * Pre-defined tag values per dimension, shown as quick-add buttons
 * in the tag management UI. Keeps tag vocabulary consistent across
 * the catalog and reduces typos from free-text entry.
 */
export const TAG_PRESETS: Record<string, string[]> = {
  lens_type: ["polarized", "uv400"],
  style: ["classic", "vintage", "contemporary"],
  season: ["Summer 2026"],
  frame_shape: [
    "round", "square", "rectangle", "oval", "aviator",
    "cat-eye", "shield", "geometric", "browline", "rimless",
  ],
};
