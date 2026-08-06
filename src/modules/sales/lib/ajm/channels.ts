/**
 * THE canonical AJM↔Jaxy channel model. Import this everywhere; never inline
 * a CASE expression for channels again.
 *
 * Why this file exists: the channel grouping was written three times with
 * three subtly different definitions, which produced a false headline ("Jaxy
 * wholesale is at 93% of AJM") because it compared the two Shopify wholesale
 * stores while ignoring AJM's separate $678k Faire business. Season-matched
 * and correctly merged, the real figure is ~40%.
 *
 * The rules, confirmed by Daniel (Aug 2026):
 *
 *   WHOLESALE = Shopify wholesale + Faire, for BOTH brands.
 *     · AJM ran Faire as its own channel, separate from its Shopify store.
 *     · Jaxy's Faire orders arrive THROUGH the Shopify wholesale store and are
 *       identifiable only by `source_name` (the same attribution the
 *       international-shipping flow relies on), not by `channel`.
 *     Merging both sides is the only apples-to-apples wholesale comparison.
 *
 *   RETAIL = DTC storefront (AJM shopify_retail / Jaxy shopify_dtc).
 *
 *   AMAZON = Jaxy only; AJM never sold there. Kept separate so it never
 *     silently pads a wholesale comparison.
 *
 * Also: AJ Morgan was a 40-year-old business that CEASED TRADING in Dec 2025.
 * Its numbers are a seasonal benchmark and an orphaned customer book — not a
 * live competitor. And sunglasses are seasonal (AJM peaks Mar–Jun, troughs in
 * Dec at ~a third of peak), so comparisons must align calendar months.
 */

/** Jaxy order → channel group. Requires `channel` and `source_name` in scope. */
export const JAXY_CHANNEL_SQL = (alias = "o") => `CASE
  WHEN ${alias}.channel = 'shopify_dtc' THEN 'retail'
  WHEN ${alias}.channel = 'amazon' THEN 'amazon'
  ELSE 'wholesale' END`;

/**
 * Jaxy wholesale split into its sub-sources, for when you specifically want to
 * see how much of wholesale came via Faire. Faire is a SUBSET of wholesale —
 * never add these two together with JAXY_CHANNEL_SQL's 'wholesale'.
 */
export const JAXY_WHOLESALE_SUBSOURCE_SQL = (alias = "o") => `CASE
  WHEN LOWER(COALESCE(${alias}.source_name,'')) LIKE '%faire%' THEN 'faire'
  ELSE 'shopify_wholesale' END`;

/** AJM order → channel group (Faire folded into wholesale to match Jaxy). */
export const AJM_CHANNEL_SQL = (alias = "o") => `CASE
  WHEN ${alias}.source = 'shopify_retail' THEN 'retail'
  ELSE 'wholesale' END`;

/** AJM sources that make up wholesale — for filters and target lists. */
export const AJM_WHOLESALE_SOURCES = ["shopify_wholesale", "faire", "oms"] as const;
export const AJM_RETAIL_SOURCES = ["shopify_retail"] as const;

export const CHANNEL_LABEL: Record<string, string> = {
  wholesale: "Wholesale (Shopify + Faire)",
  retail: "Retail (DTC)",
  amazon: "Amazon",
};

/** AJM ceased trading — anything after this is Jaxy-only territory. */
export const AJM_CEASED_TRADING = "2025-12";

/**
 * Analysis cutoff: ignore AJM history before 2022 (per Daniel, Aug 2026 —
 * older data isn't relevant to how the business runs today).
 *
 * This also removes the era that produced most of the messy data: 2019–2021
 * is where the lump-sum legacy orders live (a single line per order with an
 * invoice number as the product name, no SKU, averaging ~$700), which is why
 * AJM's early AOV looked like $701 against $157 later. Excluding it makes both
 * the category split and the AOV comparisons considerably more honest.
 *
 * Every AJM query should apply AJM_DATE_FILTER. Import counts and the
 * classifier still process all rows — we simply don't report on the old ones.
 */
export const AJM_DATA_FROM = "2022-01-01";

/** Drop-in WHERE fragment. `alias` is the ajm_orders alias in scope. */
export const AJM_DATE_FILTER = (alias = "o") => `AND ${alias}.order_date >= '${AJM_DATA_FROM}'`;

/** Peak months for sunglasses, from AJM's 2021–25 average (Mar–Jun). */
export const PEAK_MONTHS = ["03", "04", "05", "06"];
