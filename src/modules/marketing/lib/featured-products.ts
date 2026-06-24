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
