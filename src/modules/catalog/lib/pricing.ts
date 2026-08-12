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
 * FALLBACK product weight in ounces, used only when a SKU has no
 * measured weight of its own.
 *
 * Real per-style bare-frame weights come from the factory size sheet
 * and live on catalog_skus.weight_oz — measured frames run 0.64–1.44 oz
 * (18–41 g). 1 oz is the measured median, so it's the least-wrong
 * placeholder for a style we haven't weighed yet. Prefer supplying the
 * real number over relying on this.
 */
export const DEFAULT_WEIGHT_OZ = 1;

const OZ_PER_GRAM = 28.3495;

/** oz → pounds string (Faire's item_weight unit). */
export function weightLbStr(oz: number): string {
  return (oz / 16).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

/** oz → grams string (Shopify's "Weight value (grams)" column). */
export function weightGramsStr(oz: number): string {
  return (oz * OZ_PER_GRAM).toFixed(2);
}

/** oz → ounces string (Amazon's item_weight). */
export function weightOzStr(oz: number): string {
  return oz.toFixed(2);
}

/** A stored weight in oz, falling back to the placeholder above. */
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
