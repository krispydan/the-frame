/**
 * Industry classifier — maps a raw category tag (or list of tags) to one of
 * the curated Jaxy ICP buckets.
 *
 * Source data: `companies.tags` is a JSON array of strings, mostly scraped
 * from Outscraper (Google Places primary type) or Storemapper. We have ~317
 * distinct raw values across 125K rows — way too noisy for filtering or
 * email segmentation. This module collapses that long-tail into the 16-ish
 * targeted segments below.
 *
 * Rules are matched in PRIORITY ORDER (first match wins). That order matters:
 *   - Exclusions (children's, bridal, lingerie, comic) run first so they
 *     can't accidentally fall into Bookstores / Boutique / etc.
 *   - Specific industries (Eyewear, Pharmacy, Museum) run before general
 *     ones (Boutique, Apparel, General retail).
 *   - "unclassified" is the floor — only reached if no rule matched.
 *
 * Decisions from product on the segment cut (May 2026):
 *   - Car washes: real customers, dedicated segment (impulse-buy displays).
 *   - Bookstores: adult-only; children's book stores → out_of_scope.
 *   - Pharmacies: independent OK, but we still call it "Pharmacy" — the ICP
 *     classifier handles chain-vs-indie elsewhere.
 *   - Bridal, lingerie, comic-book stores: not our ICP. Out of scope.
 *   - Kids/children/baby anything (clothing, books, gifts): out of scope.
 *   - Vintage = a segment (vintage clothing, antiques, record stores).
 *   - Souvenir/tourist: own segment (impulse-buy, price-sensitive — different
 *     pitch from a curated boutique).
 *   - Spa/salon/wellness: one combined segment.
 */

export type Industry =
  | "eyewear_optical"
  | "boutique_gift"
  | "jewelry_accessories"
  | "resort_beach"
  | "souvenir_tourist"
  | "vintage"
  | "bookstore"
  | "museum_gallery"
  | "pharmacy"
  | "car_wash"
  | "spa_salon_wellness"
  | "apparel_fashion"
  | "general_retail"
  | "low_fit"
  | "out_of_scope"
  | "unclassified";

export const INDUSTRY_DISPLAY: Record<Industry, { label: string; tier: "A" | "B" | "C" | "D" | "F"; description: string }> = {
  eyewear_optical:      { label: "Eyewear & optical",      tier: "A", description: "Optical / optometry / sunglasses-specific" },
  boutique_gift:        { label: "Boutique & gift",        tier: "A", description: "Curated indie retailers, gift shops, fashion boutiques" },
  jewelry_accessories:  { label: "Jewelry & accessories",  tier: "A", description: "Jewelry and accessories shops — adjacent merchandising" },
  resort_beach:         { label: "Resort, beach & surf",   tier: "A", description: "Seasonal, polarized-heavy" },
  souvenir_tourist:     { label: "Souvenir & tourist",     tier: "B", description: "Tourist volume, price-sensitive" },
  vintage:              { label: "Vintage",                tier: "A", description: "Vintage clothing, antiques, records" },
  bookstore:            { label: "Bookstores",             tier: "A", description: "Adult-focused bookstores — readers are a natural pair" },
  museum_gallery:       { label: "Museums & galleries",    tier: "A", description: "Museum / gallery gift shops" },
  pharmacy:             { label: "Pharmacies",             tier: "A", description: "Independent pharmacies — strong reader audience" },
  car_wash:             { label: "Car washes",             tier: "B", description: "Impulse-buy display merchandising near checkout" },
  spa_salon_wellness:   { label: "Spa, salon & wellness",  tier: "B", description: "Retail-near-service: spa, salon, yoga, wellness" },
  apparel_fashion:      { label: "Apparel & fashion",      tier: "B", description: "General clothing not coded boutique" },
  general_retail:       { label: "General retail",         tier: "C", description: "Variety, department, mall stores" },
  low_fit:              { label: "Low-fit retail",         tier: "D", description: "Convenience, liquor, vape, pawn — visible but de-prioritized" },
  out_of_scope:         { label: "Out of scope",           tier: "F", description: "Hidden by default — unrelated services or excluded ICP" },
  unclassified:         { label: "Unclassified",           tier: "C", description: "Tag didn't match any rule yet" },
};

/**
 * Ordered matcher rules. First rule whose regex matches the normalized tag
 * wins. Regexes run against a lower-cased, single-space-collapsed version
 * of the tag.
 */
interface Rule {
  pattern: RegExp;
  industry: Industry;
  reason: string;
}

const RULES: Rule[] = [
  // ── Exclusions (run first so they pre-empt anything below) ──

  // Kids / children / baby anything — we don't have kids glasses (confirmed)
  { pattern: /\b(children|kids|baby|infant|youth)\b/, industry: "out_of_scope", reason: "kids/children — no kids glasses SKU" },

  // Bridal & lingerie — confirmed not ICP
  { pattern: /\b(bridal|lingerie)\b/, industry: "out_of_scope", reason: "bridal/lingerie — not ICP" },

  // Comic-book stores — confirmed not ICP
  { pattern: /\bcomic\b/, industry: "out_of_scope", reason: "comic shop — not ICP" },

  // Professional services that occasionally end up tagged as "store" by Google
  // Places — definitely not retailers we sell to.
  { pattern: /\b(plumb|hvac|roofing|electric(?:ian|al)?|landscap|towing|locksmith|moving|funeral|storage facility|self-storage)\b/, industry: "out_of_scope", reason: "professional service" },
  { pattern: /\b(dentist|dental|doctor|physician|medical clinic|veterinar|hospital|chiropract|orthodontist)\b/, industry: "out_of_scope", reason: "medical / vet" },
  { pattern: /\b(auto (?:parts|repair|body|service)|tire shop|car (?:dealer|repair|service))\b/, industry: "out_of_scope", reason: "auto service" },
  { pattern: /\blaundromat|laundry service|dry clean/, industry: "out_of_scope", reason: "laundry / dry cleaning" },
  { pattern: /\b(wholesaler|distributor|fashion designer|recording studio|engraver|dressmaker|seamstress|alteration service)\b/, industry: "out_of_scope", reason: "B2B / production service" },
  { pattern: /\b(internet shop|e-?commerce service|business center|event venue|park|public library|historical landmark|historical place|visitor center|tourist information center|arts? organization|book publisher|business association|non-?profit organization)\b/, industry: "out_of_scope", reason: "non-retail" },

  // Hospitality / food / general services — not a fit for eyewear merchandising
  { pattern: /\b(coffee shop|coffee shops|caf[eé]\b|restaurant|bakery|tea (?:room|house|shop)|deli(?:catessen)?|juice bar)\b/, industry: "out_of_scope", reason: "food / hospitality" },

  // Specialty goods that aren't our buyer: furniture, music instruments,
  // florists, art supplies, game stores (video games etc.)
  { pattern: /\b(furniture store|antique furniture|home furnishings)\b/, industry: "out_of_scope", reason: "furniture" },
  { pattern: /\bflorist\b/, industry: "out_of_scope", reason: "florist" },
  { pattern: /\bart supply store\b/, industry: "out_of_scope", reason: "art supply" },
  { pattern: /\b(music store|musical instrument|video game)\b/, industry: "out_of_scope", reason: "music instruments / video games" },
  { pattern: /\bgame store\b/, industry: "out_of_scope", reason: "game store" },

  // System / workflow tags — not real categories. Fall through to other tags.
  { pattern: /^(manual_review|review|todo|tbd)$/, industry: "unclassified", reason: "system flag, not a category" },

  // ── Specific industries (specific before general) ──

  // Eyewear / optical — most specific first
  { pattern: /\b(optometrist|optician|optical|eye care|eye exam|sunglasses store|eyewear)\b/, industry: "eyewear_optical", reason: "eyewear/optical" },

  // Car washes — confirmed dedicated segment
  { pattern: /\bcar wash\b/, industry: "car_wash", reason: "car wash" },

  // Museums & galleries (museum shops, art museums, art galleries)
  { pattern: /\b(museum|art gallery|modern art|history museum)/, industry: "museum_gallery", reason: "museum or gallery" },

  // Pharmacies — independent or chain (chain detection later by ICP classifier)
  { pattern: /\b(pharmacy|drug ?store|chemist)\b/, industry: "pharmacy", reason: "pharmacy" },

  // Bookstores — exclude comic (caught above) and children's (caught above);
  // include used, rare, religious, general
  { pattern: /\b(book ?store|used book|rare book|book shop|bookseller|book ?stores?)\b/, industry: "bookstore", reason: "bookstore" },

  // Vintage / antique / record stores / collectibles / second-hand
  // "Sports memorabilia" + "Collectibles" + "Second hand" all share the
  // vintage curation vibe.
  { pattern: /\b(vintage|antique|record store|collectibles|sports memorabilia|second hand|secondhand)\b/, industry: "vintage", reason: "vintage / antique / collectibles" },

  // Souvenir & tourist (do this BEFORE resort_beach so a "tourist souvenir
  // shop" doesn't get swallowed by the beach bucket). Christmas stores are
  // touristy / seasonal — same bucket.
  { pattern: /\b(souvenir|gift basket|tourist|attractions|christmas store|native american goods)\b/, industry: "souvenir_tourist", reason: "souvenir/tourist" },

  // Resort / beach / surf
  { pattern: /\b(resort|beach|surf|snowboard|ski shop|swim ?wear)\b/, industry: "resort_beach", reason: "resort/beach/surf" },

  // Spa / salon / wellness / yoga / fitness (also hair, nails, massage)
  { pattern: /\b(spa\b|salon|wellness|yoga|fitness|massage|hair (?:studio|salon)|nail (?:bar|salon)|barber)\b/, industry: "spa_salon_wellness", reason: "spa/salon/wellness" },

  // Jewelry & accessories
  { pattern: /\b(jewel(?:er|ry)|fashion accessories|leather goods)\b/, industry: "jewelry_accessories", reason: "jewelry/accessories" },

  // ── General buckets ──

  // Boutique & gift — also catch women's clothing per product decision.
  // Includes curated specialty shops that sit in the gift/boutique niche:
  // chocolate/candy/spice/candle/stationery/greeting cards/rock-and-crystal/
  // metaphysical (crystals, etc.) / religious goods.
  { pattern: /\b(boutique|gift ?shop|gift store|women['']?s? clothing|fashion boutique|consignment|stationery store|chocolate shop|candy store|spice store|candle store|greeting card|metaphysical|rock shop|religious goods|novelty store)\b/, industry: "boutique_gift", reason: "boutique / curated gift" },

  // Apparel & fashion (not caught as boutique above)
  { pattern: /\b(clothing store|apparel|dress store|men['']?s? clothing|formal wear|t-?shirt store|shoe store|boot store|hat store|sportswear|outerwear|outdoor clothing)\b/, industry: "apparel_fashion", reason: "general apparel" },

  // Low-fit
  { pattern: /\b(convenience store|liquor|wine store|gas station|smoke shop|vape|tobacco|pawn|thrift|dollar store|check cashing|cannabis|adult store)\b/, industry: "low_fit", reason: "low-fit retail" },

  // General retail (catch-alls — only reached if nothing more specific matched).
  // Includes sporting / outdoor goods, markets, toy stores (note: explicit
  // exclusion rule above already kicks children's-only stores out).
  { pattern: /\b(general store|department store|variety store|discount store|shopping mall|outlet|grocery store|home goods|specialty store|hobby store|toy store|sporting goods|outdoor sports|^market$|farmer'?s market)\b/, industry: "general_retail", reason: "general retail" },

  // Catch-all generic "Store" / "retail" / "shop"
  { pattern: /^(store|shop|retail|retailer)$/, industry: "general_retail", reason: "generic retail" },
];

export interface IndustryMatch {
  industry: Industry;
  reason: string;
  matchedTag: string | null;  // which tag won (helpful for debugging)
}

function normalizeTag(tag: string): string {
  return tag.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Map a single tag. Returns "unclassified" if no rule matched.
 * Exported mainly for unit tests; production callers usually want mapTagsToIndustry.
 */
export function mapTagToIndustry(tag: string | null | undefined): IndustryMatch {
  if (!tag) return { industry: "unclassified", reason: "empty tag", matchedTag: null };
  const norm = normalizeTag(tag);
  for (const rule of RULES) {
    if (rule.pattern.test(norm)) {
      return { industry: rule.industry, reason: rule.reason, matchedTag: tag };
    }
  }
  return { industry: "unclassified", reason: "no rule matched", matchedTag: tag };
}

/**
 * Map an array of tags (e.g. the JSON `companies.tags` payload). Walks each
 * tag through the rules and returns the FIRST high-confidence match — i.e.
 * any rule that produced something other than "unclassified" or the
 * pass-through "unclassified" from system flags.
 *
 * Falls through to "unclassified" only if no tag matched any rule.
 */
export function mapTagsToIndustry(tags: ReadonlyArray<string>): IndustryMatch {
  if (!tags || tags.length === 0) {
    return { industry: "unclassified", reason: "no tags", matchedTag: null };
  }
  // First pass: take first definitive match (anything not "unclassified")
  for (const t of tags) {
    const m = mapTagToIndustry(t);
    if (m.industry !== "unclassified") return m;
  }
  return { industry: "unclassified", reason: "no tags matched any rule", matchedTag: tags[0] ?? null };
}

/**
 * Parse the JSON-string form that lands in `companies.tags`. Tolerant of
 * malformed values — returns [] on parse failure rather than throwing.
 */
export function parseTagsBlob(blob: string | null | undefined): string[] {
  if (!blob) return [];
  try {
    const parsed = JSON.parse(blob);
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
    return [];
  } catch {
    return [];
  }
}
