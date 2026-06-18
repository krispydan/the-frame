/**
 * Canonical sunglass-brand competitor mapping.
 *
 * The eyewear crawl populates two free-text fields per store:
 *   - companies.top_brand            (highest-share brand in catalog)
 *   - companies.eyewear_top_competitors  (pipe-separated, up to 3)
 *
 * Both are messy: capitalization varies ("FREYRS" vs "Freyrs" vs
 * "FREYRS Eyewear"), the top_brand isn't always eyewear-specific
 * (e.g. "Pretty Simple" is a general apparel brand), and some
 * entries are luxury houses (Gucci/Chanel/Prada) that don't compete
 * with Jaxy's $8 wholesale / $28 MSRP positioning.
 *
 * This module normalizes the noise to a fixed set of 17 brands
 * Jaxy directly competes with — confirmed by Daniel 2026-06-19 by
 * reviewing the raw top-30 frequency list. The set drives:
 *
 *   - The `primary_competitor_brand` column on companies (backfilled
 *     via /api/admin/sales/backfill-competitor-brand)
 *   - The `primary_competitor` custom variable pushed to Instantly
 *     (for mail-merge in the Brand Carriers campaign)
 *   - The Brand Carriers smart list filter
 */

/**
 * The 17 brands Jaxy directly competes with. Stores carrying any of
 * these get tagged so we can run a single Brand Carriers campaign
 * that swaps the competitor mention via Instantly mail-merge.
 */
export const TARGET_COMPETITOR_BRANDS = [
  "FREYRS",
  "DAX Eyewear",
  "Fashion City",
  "DIFF Eyewear",
  "Cramilo Eyewear",
  "I-SEA",
  "Quay",
  "WMP Eyewear",
  "Peepers",
  "Anarchy Street",
  "Krewe",
  "Ave Shops",
  "3AM BY H&D",
  "Goodr",
  "Le Specs",
  "ACCITY",
  "Blue Planet Eco-Eyewear",
] as const;

export type CompetitorBrand = (typeof TARGET_COMPETITOR_BRANDS)[number];

const TARGET_SET = new Set<string>(TARGET_COMPETITOR_BRANDS);

/**
 * Map a raw brand string to its canonical form. Returns null if the
 * brand isn't in our target competitor set (luxury houses, general
 * apparel brands, etc. — all noise for the campaign).
 */
export function canonicalCompetitorBrand(raw: string | null | undefined): CompetitorBrand | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Apply normalization regexes to collapse capitalization + suffix
  // variants ("FREYRS Eyewear" → "FREYRS", "Quay Australia" → "Quay").
  // Order matters — more specific matches first.
  let canonical: string | null = null;
  if (/^freyrs/i.test(s))                                  canonical = "FREYRS";
  else if (/^cramilo/i.test(s))                            canonical = "Cramilo Eyewear";
  else if (/^dax( eyewear)?\b/i.test(s))                   canonical = "DAX Eyewear";
  else if (/^wmp( eyewear)?\b/i.test(s))                   canonical = "WMP Eyewear";
  else if (/^quay( australia)?\b/i.test(s))                canonical = "Quay";
  else if (/^diff( eyewear| charitable)?\b/i.test(s))      canonical = "DIFF Eyewear";
  else if (/^le specs/i.test(s))                           canonical = "Le Specs";
  else if (/^i-?sea\b/i.test(s))                           canonical = "I-SEA";
  else if (/^krewe\b/i.test(s))                            canonical = "Krewe";
  else if (/^peepers\b/i.test(s))                          canonical = "Peepers";
  else if (/^goodr\b/i.test(s))                            canonical = "Goodr";
  else if (/^blue planet/i.test(s))                        canonical = "Blue Planet Eco-Eyewear";
  else if (/^anarchy street/i.test(s))                     canonical = "Anarchy Street";
  else if (/^fashion city/i.test(s))                       canonical = "Fashion City";
  else if (/^3am by h&d/i.test(s))                         canonical = "3AM BY H&D";
  else if (/^accity\b/i.test(s))                           canonical = "ACCITY";
  else if (/^ave shops/i.test(s))                          canonical = "Ave Shops";
  else                                                     canonical = s;

  return TARGET_SET.has(canonical) ? (canonical as CompetitorBrand) : null;
}

/**
 * Resolve a company's primary competitor brand. Checks top_brand first
 * (the highest-share brand in the catalog), falls back to scanning the
 * pipe-separated eyewear_top_competitors list for the first match. This
 * catches stores whose dominant brand is non-eyewear (e.g. apparel) but
 * who still carry a target competitor in their broader catalog.
 *
 * Returns null when no target brand is found anywhere.
 */
export function resolvePrimaryCompetitor(opts: {
  topBrand: string | null | undefined;
  competitors: string | null | undefined;
}): CompetitorBrand | null {
  const fromTop = canonicalCompetitorBrand(opts.topBrand);
  if (fromTop) return fromTop;

  if (!opts.competitors) return null;
  for (const part of String(opts.competitors).split("|")) {
    const c = canonicalCompetitorBrand(part);
    if (c) return c;
  }
  return null;
}
