/**
 * Jaxy standard product values — pricing and shipping weight.
 *
 * Every Jaxy frame — sunglasses and readers alike — ships at the same
 * price on every channel: $8 wholesale, $28 retail, and weighs 2 oz.
 * These are the defaults applied to any new product/SKU at creation
 * (intake, PO import) and the fallback the exporters use when a row
 * somehow has no value of its own.
 *
 * Single source of truth: change it here, not in the exporters.
 */

/** Wholesale (Faire, line-sheet) price in USD. */
export const DEFAULT_WHOLESALE_PRICE = 8;

/** Retail (Shopify, Amazon) price in USD. */
export const DEFAULT_RETAIL_PRICE = 28;

/** Formatted for CSV/feed columns that want a 2-dp string. */
export const DEFAULT_WHOLESALE_PRICE_STR = DEFAULT_WHOLESALE_PRICE.toFixed(2);
export const DEFAULT_RETAIL_PRICE_STR = DEFAULT_RETAIL_PRICE.toFixed(2);

/**
 * Shipping weight per pair, in ounces. Every Jaxy frame is treated as
 * 2 oz — the channels previously disagreed (Faire 0.10 lb, Amazon
 * 1.60 oz, Shopify 42.52 g / 1.5 oz), which made shipping estimates
 * inconsistent between storefronts.
 */
export const DEFAULT_WEIGHT_OZ = 2;

/** Same weight in pounds (Faire's item_weight unit). */
export const DEFAULT_WEIGHT_LB_STR = (DEFAULT_WEIGHT_OZ / 16).toFixed(4).replace(/0+$/, "");

/** Same weight in grams (Shopify's "Weight value (grams)" column). */
export const DEFAULT_WEIGHT_G_STR = (DEFAULT_WEIGHT_OZ * 28.3495).toFixed(2);

/** Same weight as an ounces string (Amazon's item_weight). */
export const DEFAULT_WEIGHT_OZ_STR = DEFAULT_WEIGHT_OZ.toFixed(2);

/** A stored weight in oz, falling back to the Jaxy standard. */
export function weightOzOrDefault(oz: number | null | undefined): number {
  return oz && oz > 0 ? oz : DEFAULT_WEIGHT_OZ;
}

/** A stored price, falling back to the Jaxy standard when unset or zero. */
export function wholesaleOrDefault(price: number | null | undefined): number {
  return price && price > 0 ? price : DEFAULT_WHOLESALE_PRICE;
}

export function retailOrDefault(price: number | null | undefined): number {
  return price && price > 0 ? price : DEFAULT_RETAIL_PRICE;
}
