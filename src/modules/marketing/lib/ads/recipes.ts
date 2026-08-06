/**
 * Ad recipe registry — code-registered layout templates (the same
 * pattern as video recipes, but layouts live in code because they ship
 * with their renderer; only per-ad overrides go to the DB).
 *
 * All coordinates are NORMALIZED (0–1 of frame width/height). The
 * canvas editor drags these exact numbers and the renderers consume
 * them, so the preview is the render. A card's on-screen height derives
 * from its width via the recipe's fixed aspect — dragging scales the
 * whole card uniformly, text included.
 */
import type { AdRatio } from "./ratios";

export interface CardPlacement {
  /** Top-left corner of the card, fraction of frame width/height. */
  cardX: number;
  cardY: number;
  /** Card width as a fraction of frame width. */
  cardW: number;
}

export interface RatioLayout extends CardPlacement {
  /** Background crop nudge, −0.5…0.5 of crop slack (see cropWindow). */
  bgOffsetX: number;
  bgOffsetY: number;
}

export interface AdRecipe {
  slug: string;
  /** Naming-convention code (A–Z0–9, ≤8). */
  code: string;
  name: string;
  description: string;
  /** Card width/height ratio — fixed per recipe (see module docs). */
  cardAspect: number;
  defaults: Record<AdRatio, RatioLayout>;
}

const centered = (cardW: number, cardY: number): RatioLayout => ({
  cardX: (1 - cardW) / 2,
  cardY,
  cardW,
  bgOffsetX: 0,
  bgOffsetY: 0,
});

/**
 * PCARD — the product-card layout: background media fills the frame,
 * white rounded card near the bottom with the product's front-on shot
 * and its name. Card aspect 2.4:1 ≈ the reference ad's proportions
 * (wide frames sit naturally in a wide card).
 */
export const PCARD: AdRecipe = {
  slug: "pcard",
  code: "PCARD",
  name: "Product card",
  description: "Media background with a white product card (front image + name) near the bottom.",
  cardAspect: 2.4,
  defaults: {
    // cardY leaves the card's bottom edge ~6-8% above the frame bottom
    // at default scale; faces stay clear above it (upper-centre crop).
    "4x5": centered(0.86, 0.66),
    "1x1": centered(0.86, 0.62),
    "9x16": centered(0.8, 0.72),
    "16x9": centered(0.42, 0.5),
  },
};

const REGISTRY: Record<string, AdRecipe> = { [PCARD.slug]: PCARD };

export function getAdRecipe(slug: string): AdRecipe | null {
  return REGISTRY[slug] ?? null;
}

export function listAdRecipes(): AdRecipe[] {
  return Object.values(REGISTRY);
}

/**
 * Effective layout for one ratio: recipe defaults patched with the ad's
 * stored overrides (the canvas editor writes partial objects — only the
 * fields the user actually moved).
 */
export function effectiveLayout(
  recipe: AdRecipe,
  ratio: AdRatio,
  overrides: Partial<RatioLayout> | undefined,
): RatioLayout {
  const base = recipe.defaults[ratio];
  const merged = { ...base, ...(overrides ?? {}) };
  const clamp = (v: number, lo: number, hi: number) =>
    Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : 0;
  return {
    // Card can hang slightly off-frame (deliberate bleed) but not vanish.
    cardX: clamp(merged.cardX, -0.5, 0.95),
    cardY: clamp(merged.cardY, -0.5, 0.95),
    cardW: clamp(merged.cardW, 0.1, 1.5) || base.cardW,
    bgOffsetX: clamp(merged.bgOffsetX, -0.5, 0.5),
    bgOffsetY: clamp(merged.bgOffsetY, -0.5, 0.5),
  };
}

/** Parse the ad's layout_overrides JSON column (null/garbage → {}). */
export function parseLayoutOverrides(
  json: string | null | undefined,
): Partial<Record<AdRatio, Partial<RatioLayout>>> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
