/**
 * Versioned LLM classifier prompt for prospect industry + ICP classification.
 *
 * Lives in TypeScript so it's source-controlled, type-checked against
 * INDUSTRY_DISPLAY, and version-stamped. The Mac-mini classifier worker
 * imports this directly so prompt updates ship via deploy, not by editing
 * a file on the Mac.
 *
 * BUMP PROMPT_VERSION whenever you meaningfully change the prompt. The
 * audit table stamps every classification with the version, so you can
 * tell which rows are stale and worth re-running.
 */

import { INDUSTRY_DISPLAY, type Industry } from "./industry-mapping";

export const PROMPT_VERSION = "v2.2-2026-05-14";

export const SYSTEM_PROMPT = `\
You are classifying retail businesses as potential WHOLESALE customers
for Jaxy Eyewear, a US eyewear brand.

═══════════════════════════════════════════════════════════════════
JAXY'S PRODUCT LINE
═══════════════════════════════════════════════════════════════════
- Adult sunglasses (mid-priced, fashion-forward)
- Adult reading glasses
- NO kids glasses, NO prescription Rx frames

═══════════════════════════════════════════════════════════════════
JAXY'S BUYER PROFILE
═══════════════════════════════════════════════════════════════════
- Small independent retailers (5 or fewer physical locations)
- Carry MULTIPLE brands of merchandise (NOT single-brand boutiques)
- Serve ADULT customers
- US-based only
- Online-only stores ARE fine (Faire-style buyers)

═══════════════════════════════════════════════════════════════════
INDUSTRIES JAXY SELLS TO
═══════════════════════════════════════════════════════════════════
1.  eyewear_optical       — indie opticians, sunglass shops
2.  boutique_gift         — curated gift / fashion boutique / women's clothing
3.  jewelry_accessories   — indie jewelry / accessory stores
4.  resort_beach          — resort wear, surf shops, beachwear, HOTEL GIFT SHOPS,
                            hotel resort boutiques, marina/lodge gift retail
5.  souvenir_tourist      — souvenir / tourist gift / Christmas stores
6.  vintage               — vintage clothing, antiques, records, THRIFT stores
7.  bookstore             — ADULT-focused bookstores only
8.  museum_gallery        — museum / gallery gift shops
9.  pharmacy              — RETAIL-counter pharmacies, indie or small chain
                            (NOT compounding-only, veterinary, or IV pharmacies)
10. car_wash              — car washes (impulse-buy displays at register)
11. spa_salon_wellness    — spa / salon / yoga / wellness / fitness
12. apparel_fashion       — general clothing (men's, formal, etc.)
13. general_retail        — variety / market / mall stores

═══════════════════════════════════════════════════════════════════
NEVER A FIT (industry = "out_of_scope")
═══════════════════════════════════════════════════════════════════
- Children, kids, baby retailers (no kids products)
- Bridal, lingerie
- Comic book stores
- Food: restaurants, cafes, bakeries, coffee shops
- Hotels THEMSELVES are not automatically out of scope if they clearly have
  an on-site gift shop, boutique, resort retail, or tourist retail component
- Music instruments, video games, art supplies
- Furniture stores, florists
- Professional services (plumbing, dental, auto repair, medical, legal)
- Non-profits, libraries, parks, public services

═══════════════════════════════════════════════════════════════════
WHAT MAKES A CHAIN (is_chain = true)
═══════════════════════════════════════════════════════════════════
A business is a CHAIN (reject) if ANY of:
- Has MORE THAN 5 physical locations
- Is a recognized national/regional brand
- Name contains numbered location markers ("Store #1234")
- Website is a corporate domain serving many storefronts

Known chains to flag (use your knowledge of US retail too):
- Eyewear: LensCrafters, Sunglass Hut, Pearle Vision, Warby Parker,
  Visionworks, EyeMart, America's Best, For Eyes
- Pharmacy: CVS, Walgreens, Rite Aid, Duane Reade, Walmart Pharmacy
- Department/Big-box: Macy's, Nordstrom, JCPenney, Target, Walmart,
  Kohl's, TJ Maxx, Marshalls, HomeGoods, Costco, Sam's Club
- Bookstore: Barnes & Noble, Books-A-Million
- Apparel: Old Navy, Gap, H&M, Zara, Forever 21, American Eagle,
  Uniqlo, Urban Outfitters, Anthropologie
- Convenience: 7-Eleven, Circle K, Wawa

If a business looks like it MIGHT be a regional 2-10 location chain
but you're not sure: set is_chain=false and add the flag
"small_chain_likely" — a human will confirm.

═══════════════════════════════════════════════════════════════════
LUXURY-BRAND MONO-RETAILERS — REJECT (flag "luxury_brand_focused")
═══════════════════════════════════════════════════════════════════
Single-brand-focused luxury retailers are NOT a fit — they buy direct
from the brand. Examples to reject with this flag:
- "Gucci Eyewear Boutique"
- "Persol San Francisco"
- "Authorized Tom Ford Dealer"

Multi-brand retailers that carry SOME luxury alongside others are
FINE — those are good prospects.

═══════════════════════════════════════════════════════════════════
PHARMACY SPECIFICITY
═══════════════════════════════════════════════════════════════════
Approve retail pharmacies (walk-in counter + OTC retail floor).
Flag "non_retail_pharmacy" (→ reject) for:
- Compounding-only pharmacies
- Veterinary pharmacies
- IV / infusion pharmacies
- Mail-order specialty pharmacies with no retail location

═══════════════════════════════════════════════════════════════════
CONFIDENCE CALIBRATION
═══════════════════════════════════════════════════════════════════
HOTEL / RESORT / LODGE / MARINA RULE
═══════════════════════════════════════════════════════════════════
If a hotel, resort, lodge, inn, marina, or spa property clearly has an
on-site gift shop, boutique, sundry shop, retail shop, resort wear store,
or tourist/gift merchandise, it CAN be a fit.
- Classify those as `resort_beach`, `souvenir_tourist`, `boutique_gift`,
  or `general_retail`, depending on the merchandise signal.
- Do NOT reject purely because it is attached to a hotel property.
- Reject as `out_of_scope` only when the business appears to be lodging or
  hospitality-only, with no meaningful retail/gift/shop signal.

═══════════════════════════════════════════════════════════════════
CONFIDENCE CALIBRATION
═══════════════════════════════════════════════════════════════════
- 0.9+   : Name + tags + enrichment all align unambiguously
- 0.7-0.9: Strong signals but one gap (e.g. no enrichment text)
- 0.5-0.7: Mixed signals or only name available
- <0.5   : Almost no signal — also include flag "weak_data"

═══════════════════════════════════════════════════════════════════
OUTPUT
═══════════════════════════════════════════════════════════════════
For each input row, output ONE object inside a "classifications" array.
The output must be valid JSON in this exact shape:

{
  "classifications": [
    {
      "id":         "<echo input id>",
      "industry":   "<one of the 16 industry keys, or 'out_of_scope'>",
      "is_chain":   true | false,
      "confidence": 0.0–1.0,
      "reasoning":  "<one sentence; cite the strongest signal>",
      "flags":      []   // omit or empty array if nothing applies
    }
  ]
}

VALID flags:
  "kids_focused"           — kids-only, no adult merchandise
  "luxury_brand_focused"   — single-luxury-brand boutique
  "non_retail_pharmacy"    — compounding / vet / IV pharmacy
  "small_chain_likely"     — looks like 2-10 location regional
  "outside_us"             — not US-based
  "low_traffic_signal"     — <5 google reviews or rating <3.5
  "weak_data"              — almost no info to classify from

Output ONLY the JSON object. No prose, no preamble, no code fences.`;

// ── Types matching the prompt's output schema ──

export interface LlmInputRow {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  country: string | null;
  website: string | null;
  tags: string[];
  products_carried: string | null;
  rating: number | null;
  review_count: number | null;
  has_instagram: boolean;
  has_facebook: boolean;
  prior_guess: string | null;
  enrichment_text: string | null;
}

export type LlmFlag =
  | "kids_focused"
  | "luxury_brand_focused"
  | "non_retail_pharmacy"
  | "small_chain_likely"
  | "outside_us"
  | "low_traffic_signal"
  | "weak_data";

export interface LlmOutputRow {
  id: string;
  industry: Industry | "out_of_scope";
  is_chain: boolean;
  confidence: number;
  reasoning: string;
  flags?: LlmFlag[];
}

export interface LlmBatchOutput {
  classifications: LlmOutputRow[];
}

/** Build the user message from a list of input rows (typically 5–10 per batch). */
export function buildUserPrompt(rows: LlmInputRow[]): string {
  const lines: string[] = [`Classify these ${rows.length} prospect${rows.length === 1 ? "" : "s"}:`, ""];
  for (const r of rows) {
    lines.push(JSON.stringify(r));
  }
  return lines.join("\n");
}

/** Build a single LLM input row from a DB company row + optional enrichment. */
export interface CompanyForClassification {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  country: string | null;
  website: string | null;
  tags: string[];
  category: string | null;
  google_rating: number | null;
  google_review_count: number | null;
  instagram_url: string | null;
  facebook_url: string | null;
  industry: string | null;
}

export function toLlmInput(
  c: CompanyForClassification,
  enrichmentText: string | null,
): LlmInputRow {
  return {
    id: c.id,
    name: c.name,
    city: c.city,
    state: c.state,
    country: c.country,
    website: c.website,
    tags: c.tags ?? [],
    products_carried: c.category,
    rating: c.google_rating,
    review_count: c.google_review_count,
    has_instagram: !!c.instagram_url,
    has_facebook: !!c.facebook_url,
    prior_guess: c.industry,
    enrichment_text: enrichmentText,
  };
}

/** Sanity check that an industry value from the LLM is one we know. */
export function isKnownIndustry(s: string): s is Industry | "out_of_scope" {
  if (s === "out_of_scope") return true;
  return Object.keys(INDUSTRY_DISPLAY).includes(s);
}
