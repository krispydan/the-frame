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
  /** Total frame height edge-to-edge (mm), when supplied. Added for the
   *  Shopify metafield sync's product_detail[frame_height] feed
   *  attribute — Phase 1 added the column. */
  frameHeight?: number | null;
}

const STYLE_KEYWORDS: Record<StyleCategory, string[]> = {
  retro: ["retro", "vintage", "round", "oval", "keyhole", "browline", "classic", "tortoise", "tortoiseshell", "havana", "acetate", "clubmaster"],
  sporty: ["sport", "sporty", "athletic", "wrap", "shield", "rectangular", "active", "running", "cycling", "polarized", "mirrored"],
  professional: ["professional", "classic", "rectangular", "square", "metal", "titanium", "rimless", "semi-rimless", "business", "office"],
  fashion: ["fashion", "bold", "oversized", "cat-eye", "cat eye", "geometric", "butterfly", "aviator", "statement", "trendy", "gradient"],
  casual: ["casual", "everyday", "round", "simple", "lightweight", "comfortable", "versatile"],
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
    `Write a compelling product description for "${name}" sunglasses by Jaxy. Details: ${details}. Keep it 2-3 paragraphs, focus on style and lifestyle appeal. Brand voice: confident, approachable, modern. Never mention price, affordability, value, retail pricing, wholesale pricing, MSRP, cost, discounts, or anything being inexpensive/expensive. Never use the word "wayfarer" or "wayfarer-inspired". The copy must work unchanged for both retail and wholesale.`,
  
  shortDescription: (name: string, details: string) =>
    `Write a short product description (1-2 sentences, max 160 chars) for "${name}" by Jaxy. Details: ${details}. Never mention price, affordability, value, retail pricing, wholesale pricing, MSRP, cost, discounts, or anything being inexpensive/expensive. Never use the word "wayfarer" or "wayfarer-inspired".`,

  bulletPoints: (name: string, details: string) =>
    `Write 5 bullet points for "${name}" sunglasses by Jaxy. Details: ${details}. Each bullet should highlight a key feature or benefit. Keep each bullet under 100 characters. Never mention price, affordability, value, retail pricing, wholesale pricing, MSRP, cost, discounts, or anything being inexpensive/expensive. Never use the word "wayfarer" or "wayfarer-inspired".`,

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

// ─────────────────────────────────────────────────────────────────────────
// Deterministic SEO builders for the Shopify metafield sync (Phase 2).
//
// Formula straight from the SEO feed brief — produces stable, predictable
// titles + descriptions + body HTML from curated attrs. No LLM calls.
//
// The 39-row golden file at jaxy-seo-feed-recommendations-v2.xlsx
// matches the OUTPUT of these builders for the dominant case; spreadsheet
// outliers (Eclipse's mid-position "Polarized", Drifter/Diplomat's hybrid
// "Square Aviator", Hex's reversed "Hexagonal Vintage") are accepted
// divergences — vitest asserts per-row INVARIANTS (length, ends with
// "| Jaxy", contains shape) rather than exact string match. See
// src/__tests__/catalog/seo-builders.test.ts (Phase 6).
// ─────────────────────────────────────────────────────────────────────────

export interface SeoBuilderContext {
  /** Product display name — "Havana Haze". Required. */
  productName: string;
  /** Lower-case curated frame shape — "round", "cat-eye", "aviator",
   *  "hexagonal". Null is tolerated; title falls back to "Sunglasses". */
  frameShape: string | null;
  /** All style tag values for the product. Lower-case. Used to pick the
   *  leading STYLE modifier in priority order: oversized > slim > vintage
   *  > retro > 70s > 90s > y2k. Empty → "Classic". */
  styleTags: string[];
  /** Curated target gender — "womens" / "mens" / "unisex" / null. Only
   *  "womens" and "mens" emit " for Women" / " for Men"; everything
   *  else omits the gender clause (Google-feed best practice). */
  gender: string | null;
  /** Frame color name for the description template (e.g. "tortoise",
   *  "black"). Single dominant color only — leave null for
   *  multi-color frames. */
  frameColor?: string | null;
  /** Frame material for the description template (e.g. "acetate",
   *  "metal"). */
  frameMaterial?: string | null;
  /** "polarized" or "uv400" — drives the Features bullet. */
  lensType?: string | null;
  /** Existing marketing-prose paragraphs from products.description.
   *  Split on blank lines into <p> tags in buildBodyHtml. */
  description?: string | null;
  /** Frame dimensions in mm — drive the <h3>Frame Measurements</h3>
   *  list in buildBodyHtml. Missing values are skipped. */
  lensWidth?: number | null;
  lensHeight?: number | null;
  bridgeWidth?: number | null;
  frameWidth?: number | null;
  frameHeight?: number | null;
  templeLength?: number | null;
}

/** Title-cased frame shape per Google's product taxonomy (used in titles
 *  and descriptions). Unknown shapes pass through capitalised; the
 *  "wayfarer" → "Square" mapping is the Ray-Ban-trademark scrub. */
const FRAME_SHAPE_TITLECASE: Record<string, string> = {
  round: "Round",
  square: "Square",
  rectangle: "Rectangle",
  oval: "Oval",
  "cat-eye": "Cat Eye",
  cateye: "Cat Eye",
  aviator: "Aviator",
  hexagonal: "Hexagonal",
  oversized: "Oversized",
  geometric: "Geometric",
  butterfly: "Butterfly",
  wayfarer: "Square", // TM scrub — never emit "Wayfarer" in copy
};

function titleCaseShape(shape: string | null | undefined): string {
  const k = (shape ?? "").toLowerCase().trim();
  if (!k) return "";
  return FRAME_SHAPE_TITLECASE[k] ?? (k[0].toUpperCase() + k.slice(1));
}

/** Style modifier priority — higher in the list wins. Matches the
 *  spreadsheet's observed pattern: oversized/slim beat era markers,
 *  era markers beat the default "Classic". */
const STYLE_MODIFIER_PRIORITY: ReadonlyArray<string> = [
  "oversized", "slim", "vintage", "retro", "70s", "90s", "y2k",
];

function pickStyleModifier(styleTags: ReadonlyArray<string>): string {
  const lower = styleTags.map((s) => s.toLowerCase().trim());
  for (const mod of STYLE_MODIFIER_PRIORITY) {
    if (lower.includes(mod)) {
      // Era markers stay verbatim ("70s", "90s"); "y2k" goes uppercase.
      if (mod === "y2k") return "Y2K";
      if (mod === "70s" || mod === "90s") return mod;
      return mod[0].toUpperCase() + mod.slice(1);
    }
  }
  return "Classic";
}

function genderClause(gender: string | null | undefined): string {
  const g = (gender ?? "").toLowerCase().trim();
  if (g === "womens" || g === "women" || g === "female") return " for Women";
  if (g === "mens" || g === "men" || g === "male") return " for Men";
  return ""; // unisex / null → omit
}

/**
 * Build the SEO Title (Shopify SEO title field, used by Simprosys as
 * the Google Shopping product title).
 *
 * Formula: `{StyleModifier} {Shape} Sunglasses[ for {Gender}] — {ProductName} | Jaxy`
 *
 * Target length 50–65 chars; we don't truncate (Shopify cuts at the
 * search engine boundary, not ours).
 */
export function buildSeoTitle(ctx: SeoBuilderContext): string {
  const shape = titleCaseShape(ctx.frameShape);
  const modifier = pickStyleModifier(ctx.styleTags);
  const shapeAndModifier = shape ? `${modifier} ${shape}` : modifier;
  return `${shapeAndModifier} Sunglasses${genderClause(ctx.gender)} — ${ctx.productName} | Jaxy`;
}

/** Brand-voice tagline pool by shape, from brief Appendix A.
 *  Selection is deterministic per product (hash of product name) so the
 *  same product always gets the same tagline. */
const BRAND_VOICE_TAGLINES: Record<string, ReadonlyArray<string>> = {
  Round: [
    "a classic silhouette built for every day",
    "vintage soul, modern wear",
    "the icon you'll keep coming back to",
  ],
  Square: [
    "confident proportions, quiet ease",
    "the timeless square, refined",
    "bold without trying",
  ],
  "Cat Eye": [
    "cinematic glamour, reimagined for today",
    "vintage drama, sculpted soft",
    "Old Hollywood, modern attitude",
  ],
  Aviator: [
    "the classic, beautifully balanced",
    "vintage pilot, modern wear",
    "timeless presence",
  ],
  Oval: [
    "softly sculpted, endlessly wearable",
    "a vintage wink, beautifully simple",
  ],
  Rectangle: [
    "vintage character meets everyday comfort",
    "soft hour, strong shape",
  ],
  Hexagonal: ["familiar and fresh, like a perfect vintage find"],
};

function pickTagline(shape: string, productName: string): string {
  const pool = BRAND_VOICE_TAGLINES[shape] ?? BRAND_VOICE_TAGLINES.Square;
  // Stable hash of product name → index into pool. Same product always
  // gets the same tagline; new products land randomly across the pool.
  const seed = hashString(productName);
  return pool[Math.abs(seed) % pool.length];
}

/**
 * Build the SEO Description (meta description, search snippet fallback).
 *
 * Template: `{StyleModifier} {shape} sunglasses{, with {frame_color}
 * {material}}. The {product_name} by Jaxy — {brand voice tagline}.`
 *
 * Target 140–160 chars. If the rendered string overshoots, drop the
 * frame-color clause first; if still long, drop the tagline.
 */
export function buildSeoDescription(ctx: SeoBuilderContext): string {
  const shape = titleCaseShape(ctx.frameShape);
  const modifier = pickStyleModifier(ctx.styleTags);
  const shapeLc = shape ? shape.toLowerCase() : "";

  const tagline = pickTagline(shape || "Square", ctx.productName);

  // Frame color clause — only when one dominant color is present.
  const colorPart =
    ctx.frameColor && ctx.frameMaterial
      ? `, with ${ctx.frameColor.toLowerCase()} ${ctx.frameMaterial.toLowerCase()}`
      : ctx.frameColor
      ? `, with ${ctx.frameColor.toLowerCase()} frames`
      : "";

  const lead = shapeLc
    ? `${modifier} ${shapeLc} sunglasses${colorPart}.`
    : `${modifier} sunglasses${colorPart}.`;
  const full = `${lead} The ${ctx.productName} by Jaxy — ${tagline}.`;

  // Trim if over 160 — drop color clause first, then tagline.
  if (full.length <= 160) return full;
  const withoutColor = shapeLc
    ? `${modifier} ${shapeLc} sunglasses. The ${ctx.productName} by Jaxy — ${tagline}.`
    : `${modifier} sunglasses. The ${ctx.productName} by Jaxy — ${tagline}.`;
  if (withoutColor.length <= 160) return withoutColor;
  return shapeLc
    ? `${modifier} ${shapeLc} sunglasses. The ${ctx.productName} by Jaxy.`
    : `${modifier} sunglasses. The ${ctx.productName} by Jaxy.`;
}

/** Escape minimal HTML special characters in user-provided text before
 *  inlining into the body HTML. We don't sanitise full HTML (the
 *  products.description column is plain text or our own markdown). */
function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Build the long-form Body HTML (Shopify Body (HTML) field).
 *
 * Hybrid structure per Daniel's call:
 *   - <p>…</p> for each marketing-authored paragraph from
 *     products.description (split on blank lines).
 *   - <h3>Frame Measurements</h3><ul>…</ul> generated from the dimension
 *     columns, skipping any null value.
 *   - <h3>Features</h3><ul>…</ul> with lens-type protection, material,
 *     and any extras we can derive.
 *
 * Returns an empty string if the product has neither prose nor any
 * structural data — caller can fall back to its existing description.
 */
export function buildBodyHtml(ctx: SeoBuilderContext): string {
  const out: string[] = [];

  // ── Paragraphs from marketing prose ──
  if (ctx.description && ctx.description.trim()) {
    const paragraphs = ctx.description
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
    for (const p of paragraphs) {
      out.push(`<p>${escHtml(p)}</p>`);
    }
  }

  // ── Frame Measurements block ──
  const dimLines: string[] = [];
  if (ctx.lensWidth) dimLines.push(`<li>Lens width: ${ctx.lensWidth} mm</li>`);
  if (ctx.lensHeight) dimLines.push(`<li>Lens height: ${ctx.lensHeight} mm</li>`);
  if (ctx.bridgeWidth) dimLines.push(`<li>Bridge width: ${ctx.bridgeWidth} mm</li>`);
  if (ctx.frameWidth) dimLines.push(`<li>Frame width: ${ctx.frameWidth} mm</li>`);
  if (ctx.frameHeight) dimLines.push(`<li>Frame height: ${ctx.frameHeight} mm</li>`);
  if (ctx.templeLength) dimLines.push(`<li>Temple length: ${ctx.templeLength} mm</li>`);

  if (dimLines.length > 0) {
    out.push("<h3>Frame Measurements</h3>");
    out.push(`<ul>${dimLines.join("")}</ul>`);
  }

  // ── Features block ──
  const featureLines: string[] = [];
  const lens = (ctx.lensType ?? "").toLowerCase();
  if (lens === "polarized") {
    featureLines.push("<li>Polarized lens with UV400 protection</li>");
  } else if (lens === "uv400" || lens.includes("uv")) {
    featureLines.push("<li>UV400 protection</li>");
  }
  if (ctx.frameMaterial) {
    featureLines.push(`<li>${escHtml(titleCaseFirst(ctx.frameMaterial))} frame</li>`);
  }

  if (featureLines.length > 0) {
    out.push("<h3>Features</h3>");
    out.push(`<ul>${featureLines.join("")}</ul>`);
  }

  return out.join("\n");
}

function titleCaseFirst(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Build the Shopify variant title using the standardised
 * `{Frame Color} Frame / {Lens Color} Lens` format from brief §5.
 *
 * Falls back gracefully when data is incomplete:
 *   - Both → "Black Frame / Brown Lens"
 *   - Frame only → "Black Frame"
 *   - Legacy slash form ("Tort/Green" with no lensColorName) → split
 *     left = frame, right = lens
 *   - Null frame → "Default Title" (Shopify's own fallback)
 *
 * Reading-glasses extension: when `readingPower` is provided, the lens
 * color axis is replaced by power (and optionally a "Blue Light"
 * coating marker):
 *
 *   - Color + power → "Black Frame / +1.50"
 *   - Color + power + blue light → "Black Frame / +1.50 / Blue Light"
 *
 * The output is used as Shopify variant `option1` so the variant title
 * is automatically displayed as the same string. For sunglasses we keep
 * the single-axis convention for backward compat; reading glasses can
 * use multi-axis options at the Shopify product level when synced.
 */
export function buildVariantTitle(
  frameColor: string | null | undefined,
  lensColor: string | null | undefined,
  readingPower?: number | null,
  hasBlueLightFilter?: boolean | null,
): string {
  const fc = (frameColor ?? "").trim();
  const lc = (lensColor ?? "").trim();

  if (!fc) return "Default Title";

  // Reading-glasses path — power supersedes the lens-color axis.
  if (readingPower != null && Number.isFinite(readingPower)) {
    const framePart = `${titleCaseFirst(fc)} Frame`;
    const powerPart = `+${readingPower.toFixed(2)}`;
    const parts = [framePart, powerPart];
    if (hasBlueLightFilter) parts.push("Blue Light");
    return parts.join(" / ");
  }

  // Legacy slash-form: "Tort/Green" with no separate lens column.
  // Split + recurse so the format stays consistent. Only when the
  // explicit lens column is absent — explicit lens always wins.
  if (!lc && fc.includes("/")) {
    const [leftRaw, rightRaw] = fc.split("/", 2).map((s) => s.trim());
    if (leftRaw && rightRaw) {
      return `${titleCaseFirst(leftRaw)} Frame / ${titleCaseFirst(rightRaw)} Lens`;
    }
  }

  const framePart = `${titleCaseFirst(fc)} Frame`;
  if (!lc) return framePart;
  return `${framePart} / ${titleCaseFirst(lc)} Lens`;
}
