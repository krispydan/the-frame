/**
 * Reading-glasses domain helpers.
 *
 * Reading glasses introduce two variant axes beyond the sunglasses
 * frame-color + lens-color model:
 *
 *   1. Diopter power — one of READING_POWERS below
 *   2. Blue-light filter — boolean (some lenses, some clear)
 *
 * Both attributes live as per-SKU columns on catalog_skus
 * (reading_power, has_blue_light_filter). This module is the single
 * source of truth for what's allowed and how the values render.
 */

/**
 * The diopter powers Jaxy stocks. Same list across every reading-glasses
 * style — operations confirmed 2026-06-17 (AskUserQuestion).
 *
 * Frozen so a downstream caller can't mutate it in place.
 */
export const READING_POWERS = Object.freeze([
  1.0, 1.5, 1.75, 2.0, 2.5, 3.0,
] as const);

export type ReadingPower = (typeof READING_POWERS)[number];

/**
 * Format a diopter for customer-facing display: `1.5` → `"+1.50"`.
 * Always two decimal places, always with a leading `+` (per optical
 * convention — readers are positive-power lenses).
 */
export function formatReadingPower(power: number): string {
  return `+${power.toFixed(2)}`;
}

/**
 * Blue-light SKUs carry reading_power = 0 (not null) plus
 * has_blue_light_filter = true. Zero is deliberately NOT in
 * READING_POWERS — it is a distinct strength option, not a diopter.
 */
export const BLUE_LIGHT_POWER = 0;

/** Customer-facing label for the blue-light option. */
export const BLUE_LIGHT_LABEL = "Blue Light";

/**
 * Build the SKU suffix segment for a reading-glasses variant.
 *
 *   power=0,    blueLight=true  → "BL"
 *   power=1.5,  blueLight=false → "150"
 *   power=2.0,  blueLight=false → "200"
 *
 * Appends to the full colorway SKU, which already carries the `-R-`
 * product-type segment: `${colorwaySku}-${suffix}`, e.g.
 * `JX3010-R-BLK-150`. (Blue light is its own option rather than a
 * modifier on a diopter, so it never combines with a power.)
 *
 * Power encoded as power × 100 to keep the SKU integer-only. 1.75 → 175.
 */
export function readingSkuSuffix(power: number, hasBlueLight: boolean): string {
  if (hasBlueLight && power === BLUE_LIGHT_POWER) return "BL";
  const base = String(Math.round(power * 100));
  return hasBlueLight ? `${base}-BL` : base;
}

/** The per-SKU fields the strength axis is derived from. */
export interface ReadingVariantFields {
  readingPower?: number | null;
  hasBlueLightFilter?: boolean | null;
}

/**
 * The customer-facing strength value for a SKU — the second variation
 * axis on every channel (Shopify Option2, Faire option_2, Amazon
 * MagnificationStrength).
 *
 *   { readingPower: 0,    hasBlueLightFilter: true }  → "Blue Light"
 *   { readingPower: 1.5,  hasBlueLightFilter: false } → "+1.50"
 *
 * Returns null for a SKU with no strength (a sunglasses SKU, or the
 * power-less colorway base row) so callers can filter on it.
 */
export function strengthLabel(sku: ReadingVariantFields): string | null {
  const power = sku.readingPower;
  if (power == null) return null;
  if (sku.hasBlueLightFilter && power === BLUE_LIGHT_POWER) return BLUE_LIGHT_LABEL;
  return formatReadingPower(power);
}

/**
 * Sort comparator for the strength axis: Blue Light first, then diopters
 * ascending. Channels render options in the order we emit them, so this
 * fixes the on-listing order (BL, +1.00, +1.50, +1.75, +2.00, +2.50, +3.00).
 */
export function compareStrength(a: ReadingVariantFields, b: ReadingVariantFields): number {
  const rank = (s: ReadingVariantFields) =>
    s.hasBlueLightFilter && (s.readingPower ?? 0) === BLUE_LIGHT_POWER ? -1 : (s.readingPower ?? 0);
  return rank(a) - rank(b);
}

/**
 * True when a product is reading glasses: any SKU carries a reading
 * power. Callers that also have the tag-derived category should OR this
 * with `category === "reading"` — the tag can be missing on imports.
 */
export function hasReadingPowerSkus(skus: readonly ReadingVariantFields[]): boolean {
  return skus.some((s) => s.readingPower != null);
}

/**
 * True iff the SKU's reading_power is one of the canonical allowed values.
 * Used for validation in import + UI paths.
 */
export function isAllowedReadingPower(power: number): power is ReadingPower {
  return (READING_POWERS as readonly number[]).includes(power);
}
