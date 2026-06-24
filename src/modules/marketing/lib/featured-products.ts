/**
 * Featured-products helpers — the campaign's `featured_product_ids`
 * column stores a JSON array of catalog_products.id. These tiny pure
 * helpers parse/serialize it safely so routes + UI agree on the shape.
 */

/** Parse the stored JSON column into a clean string[] (never throws). */
export function parseFeaturedIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
}

/** Serialize ids back to the column (null when empty, so "no products"
 *  is a clean NULL rather than "[]"). */
export function serializeFeaturedIds(ids: string[] | null | undefined): string | null {
  const clean = (ids ?? []).filter((x) => typeof x === "string" && x.length > 0);
  return clean.length ? JSON.stringify(clean) : null;
}

/**
 * Planner auto-assign: decide which proposals get a featured product.
 * Product-anchored proposals (those the planner gave a non-empty
 * productHook) each get ONE product id, cycling through `poolIds` so
 * the same frame isn't repeated across the month. Non-anchored slots
 * get null (a brand/theme email). Pure → unit-testable; the route does
 * the async pool fetch and feeds the ids in.
 *
 * @returns one serialized featured_product_ids value (or null) per proposal, in order.
 */
export function assignFeaturedProductIds(
  productHooks: Array<string | null | undefined>,
  poolIds: string[],
): Array<string | null> {
  const out: Array<string | null> = productHooks.map(() => null);
  const pool = poolIds.filter(Boolean);
  if (pool.length === 0) return out;
  let k = 0;
  productHooks.forEach((hook, i) => {
    if (hook && hook.trim()) {
      out[i] = serializeFeaturedIds([pool[k % pool.length]]);
      k++;
    }
  });
  return out;
}
