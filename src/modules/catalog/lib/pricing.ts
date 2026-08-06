/**
 * Jaxy standard pricing.
 *
 * Every Jaxy frame — sunglasses and readers alike — ships at the same
 * price on every channel: $8 wholesale, $28 retail. These are the
 * defaults applied to any new product/SKU at creation (intake, PO
 * import) and the fallback the exporters use when a row somehow has no
 * price of its own.
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

/** A stored price, falling back to the Jaxy standard when unset or zero. */
export function wholesaleOrDefault(price: number | null | undefined): number {
  return price && price > 0 ? price : DEFAULT_WHOLESALE_PRICE;
}

export function retailOrDefault(price: number | null | undefined): number {
  return price && price > 0 ? price : DEFAULT_RETAIL_PRICE;
}
