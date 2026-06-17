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
 * Build the SKU suffix segment for a reading-glasses variant.
 *
 *   power=1.5,  blueLight=false → "150"
 *   power=1.5,  blueLight=true  → "150-BL"
 *   power=2.0,  blueLight=false → "200"
 *
 * Designed to slot into the existing convention
 * `${skuPrefix}-${colorCode}-${suffix}`, e.g. `JX2001-BLK-150-BL`.
 *
 * Power encoded as power × 100 to keep the SKU integer-only. 1.75 → 175.
 */
export function readingSkuSuffix(power: number, hasBlueLight: boolean): string {
  const base = String(Math.round(power * 100));
  return hasBlueLight ? `${base}-BL` : base;
}

/**
 * True iff the SKU's reading_power is one of the canonical allowed values.
 * Used for validation in import + UI paths.
 */
export function isAllowedReadingPower(power: number): power is ReadingPower {
  return (READING_POWERS as readonly number[]).includes(power);
}
