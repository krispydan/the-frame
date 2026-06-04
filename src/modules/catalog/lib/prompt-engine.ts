/**
 * Prompt Engine — ported from ~/jaxy-catalog-tool/src/lib/prompt-engine.ts
 * Handles style detection and prompt construction for AI image/copy generation.
 */

export type StyleCategory = "retro" | "sporty" | "professional" | "fashion" | "casual";

export interface ProductContext {
  productId: string;
  skuPrefix: string;
  name: string | null;
  category: "sunglasses" | "optical" | "reading";
  frameShape: string | null;
  frameMaterial: string | null;
  gender: string | null;
  lensType: string | null;
  colors: string[];
  styleCategory: StyleCategory;
  tags: Record<string, string[]>;
  // Physical frame dimensions (mm). Captured from the factory's
  // "51口22 145" string. Optional — older products may not have them yet.
  lensWidth?: number | null;
  bridgeWidth?: number | null;
  templeLength?: number | null;
  lensHeight?: number | null;
  /** Total frame width edge-to-edge (mm), when supplied. */
  frameWidth?: number | null;
}

const STYLE_KEYWORDS: Record<StyleCategory, string[]> = {
  retro: ["retro", "vintage", "round", "oval", "keyhole", "browline", "classic", "tortoise", "tortoiseshell", "havana", "acetate", "clubmaster"],
  sporty: ["sport", "sporty", "athletic", "wrap", "shield", "rectangular", "active", "running", "cycling", "polarized", "mirrored"],
  professional: ["professional", "classic", "rectangular", "square", "metal", "titanium", "rimless", "semi-rimless", "business", "office"],
  fashion: ["fashion", "bold", "oversized", "cat-eye", "cat eye", "geometric", "butterfly", "aviator", "statement", "trendy", "gradient"],
  casual: ["casual", "everyday", "wayfarer", "round", "simple", "lightweight", "comfortable", "versatile"],
};

export function detectStyleCategory(product: {
  frameShape?: string | null;
  frameMaterial?: string | null;
  gender?: string | null;
  lensType?: string | null;
  tags?: Record<string, string[]>;
}): StyleCategory {
  const allText = [
    product.frameShape, product.frameMaterial, product.gender, product.lensType,
    ...(product.tags?.style || []), ...(product.tags?.activity || []), ...(product.tags?.frameShape || []),
  ].filter(Boolean).join(" ").toLowerCase();

  const scores: Record<StyleCategory, number> = { retro: 0, sporty: 0, professional: 0, fashion: 0, casual: 0 };
  for (const [category, keywords] of Object.entries(STYLE_KEYWORDS)) {
    for (const keyword of keywords) {
      if (allText.includes(keyword)) scores[category as StyleCategory]++;
    }
  }

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? (best[0] as StyleCategory) : "casual";
}

const MODEL_DESCRIPTIONS = [
  "a young woman in her mid-20s with warm brown skin and curly dark hair",
  "a man in his late 20s with light skin, stubble, and wavy brown hair",
  "a woman in her early 30s with East Asian features and sleek black hair",
  "a man in his mid-20s with dark brown skin and a clean fade haircut",
  "a woman in her late 20s with olive skin and auburn hair",
  "a man in his early 30s with South Asian features and short dark hair",
  "a woman in her mid-35s with fair freckled skin and red hair",
  "a man in his late 20s with medium brown skin and a short beard",
  "a woman in her early 20s with light brown skin and long braids",
  "a man in his mid-30s with East Asian features and modern styled hair",
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

export function getModelDescription(productId: string, sceneIndex: number): string {
  const seed = hashString(productId) + sceneIndex;
  return MODEL_DESCRIPTIONS[Math.abs(seed) % MODEL_DESCRIPTIONS.length];
}

export function buildProductDescription(context: ProductContext): string {
  const dimensions = formatDimensionsLine(context);
  return [context.name, context.frameShape, context.frameMaterial, context.category, dimensions]
    .filter(Boolean)
    .join(" ");
}

/**
 * Compose a human-readable dimensions sentence for inclusion in prompt
 * templates. Returns "" when no dimensions are set so callers can simply
 * concatenate without branching.
 *
 *   formatDimensionsLine({ lensWidth: 51, bridgeWidth: 22, templeLength: 145 })
 *     === "Dimensions: 51-22-145 mm (lens-bridge-temple)."
 */
export function formatDimensionsLine(context: Pick<ProductContext, "lensWidth" | "bridgeWidth" | "templeLength" | "lensHeight" | "frameWidth">): string {
  const { lensWidth, bridgeWidth, templeLength, lensHeight, frameWidth } = context;
  if (!lensWidth || !bridgeWidth || !templeLength) return "";
  const base = `${lensWidth}-${bridgeWidth}-${templeLength}`;
  const extras: string[] = [];
  if (lensHeight) extras.push(`lens height ${lensHeight} mm`);
  if (frameWidth) extras.push(`frame width ${frameWidth} mm`);
  const suffix = extras.length ? ` (${extras.join(", ")})` : "";
  return `Dimensions: ${base} mm (lens-bridge-temple)${suffix}.`;
}

/** Copy generation prompt templates */
export const COPY_PROMPTS = {
  description: (name: string, details: string) =>
    `Write a compelling product description for "${name}" sunglasses by Jaxy. Details: ${details}. Keep it 2-3 paragraphs, focus on style and lifestyle appeal. Brand voice: confident, approachable, modern.`,
  
  shortDescription: (name: string, details: string) =>
    `Write a short product description (1-2 sentences, max 160 chars) for "${name}" by Jaxy. Details: ${details}.`,

  bulletPoints: (name: string, details: string) =>
    `Write 5 bullet points for "${name}" sunglasses by Jaxy. Details: ${details}. Each bullet should highlight a key feature or benefit. Keep each bullet under 100 characters.`,

  seoTitle: (name: string, category: string) =>
    `Write an SEO-optimized title for "${name}" ${category} by Jaxy. Max 60 characters. Include brand name.`,

  metaDescription: (name: string, details: string) =>
    `Write an SEO meta description for "${name}" by Jaxy. Details: ${details}. Max 160 characters. Include a call to action.`,

  /**
   * Generate product-name candidates. v2: Quay-inspired emotional
   * register + explicit legal-avoidance clause.
   *
   * Daniel's brief (June 2026): "I feel like ours need more feelings
   * attached to them, I think Quay do a good job with their product
   * naming." Names should evoke moments and moods, not describe the
   * frame. Plus: "we need to make sure the name isn't copyrighted
   * or the same as other eyewear brands for legal reasons."
   *
   * @param productCategory  Drives tonal register. Reading glasses
   *   should read approachable/grown-up; sunglasses should read
   *   confident/lifestyle-forward; blue light sits between.
   * @param details          Frame attributes blob (category, shape,
   *   material, gender, tags) — passed verbatim into the prompt.
   */
  productName: (
    productCategory: "sunglasses" | "reading glasses" | "blue light",
    details: string,
  ) =>
    `You're naming a new ${productCategory} style for Jaxy — a modern, lifestyle-driven eyewear brand.

Frame details: ${details}.

Generate 8 candidate names following these rules:

STYLE
- 1–2 words, max 14 characters total. Easy to say out loud.
- Evoke a MOMENT, MOOD, or ATTITUDE — not the frame itself.
  Strong references: late nights, music, motion, weather, light,
  small intimate scenes, after-hours energy, golden-hour calm.
  Weak references: literal colors, frame shapes, technical specs.
- The name should make you feel something the second you read it.
- Mix registers across your 8: some single evocative nouns
  (Encore, Vesper, Static), some short verb/state phrases
  (All In, Closing Time, Off Duty), one wildcard.
- Avoid clichés saturated in eyewear: Aviator, Rebel, Maverick,
  Icon, Classic, Vintage, Modern.
- Names must read as ${productCategory === "reading glasses"
      ? "approachable + grown-up + un-fussy"
      : productCategory === "blue light"
      ? "calm + focused + everyday-friendly"
      : "confident + lifestyle-forward"}.

LEGAL — IMPORTANT
- Do NOT propose any name you know belongs to another eyewear,
  fashion, or sunglass brand — not as a brand name, model name,
  or collection name. Examples to avoid (non-exhaustive):
  Ray-Ban / Wayfarer / Aviator / Clubmaster / Erika; Oakley /
  Holbrook / Frogskins / Sutro / Radar; Quay names (After Hours,
  Hardwire, All In, Sweet Dreams, Encore, On Repeat, Vesper,
  Empire, Soundcheck, Closing Time, Off Duty); Warby Parker /
  Felix / Percey / Haskell / Burke; Persol / Steve McQueen;
  Maui Jim / Banyans; Smith / Lowdown; Le Specs / Halfmoon
  Magic; Krewe / Conti / Clio; DIFF / Carson / Becky; Bonlook;
  Privé Revaux; Pair Eyewear; Zenni; EyeBuyDirect; Liingo;
  YESGLASSES; Felix Gray.
- Avoid trademark-style names of large consumer brands in adjacent
  categories (Apple, Tesla, Nike, Lululemon, etc.) — even when the
  literal meaning is generic.
- If a name is even SLIGHTLY at risk of overlap, do not include
  it. Pick a different angle.

OUTPUT
For each name return:
  { "name": "...",
    "vibe": "<one-line scene/mood it conjures>",
    "legal_confidence": "high" | "medium" | "low",
    "legal_notes": "<reasoning — e.g. 'common dictionary word, not a known eyewear brand' or 'low confidence — should TM search before use'>" }

Return a JSON array of 8 such objects, sorted by legal_confidence descending.
NOTE TO READER: legal_confidence: high means "the model doesn't
recall this being used in eyewear." It is NOT a trademark
guarantee. Final names must be checked against USPTO TESS
(tmsearch.uspto.gov) in class 9 + class 16 before launch.`,
};

/**
 * Infer the product-name category from whatever signals are
 * available on the product row. Reading glasses are flagged by
 * the SKU pattern Jaxy uses (`-R-` segment, e.g. `JX5001-R-BLK`)
 * or by a category string containing "reading". Blue light similar.
 * Default falls back to sunglasses — the bulk of the catalog.
 */
export function inferProductNameCategory(input: {
  sku?: string | null;
  category?: string | null;
  tags?: string | null;
}): "sunglasses" | "reading glasses" | "blue light" {
  const sku = (input.sku ?? "").toUpperCase();
  const cat = (input.category ?? "").toLowerCase();
  const tags = (input.tags ?? "").toLowerCase();

  if (sku.includes("-R-") || cat.includes("reading") || tags.includes("reading")) {
    return "reading glasses";
  }
  if (sku.includes("-B-") || cat.includes("blue light") || tags.includes("blue light")) {
    return "blue light";
  }
  return "sunglasses";
}
