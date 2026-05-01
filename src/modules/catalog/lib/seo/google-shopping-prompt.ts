/**
 * Prompt builder for Google Shopping SEO copy generation.
 *
 * The output of this module is a (system, user) pair sent to Claude.
 * Output JSON schema matches AiSeoOutput below — caller validates.
 *
 * Why a static prompt vs. a learned one: SEO copy benefits from
 * deterministic constraints (length, banned words, trademark guards)
 * that we can reason about and audit. Letting the model "be creative"
 * within those constraints is the design intent.
 */

export interface AiSeoInput {
  /** Product display name, e.g. "Monroe". */
  name: string;
  /** Jaxy SKU prefix, e.g. "JX1001". */
  skuPrefix: string;
  /** "Sunglasses" / "Optical Glasses" / "Reading Glasses" — driven by tags */
  category: string;
  /** Frame shape (display label, e.g. "Cat-Eye", "Rectangle", "Aviator"). */
  frameShape: string | null;
  /** Frame material (e.g. "Acetate") if curated. */
  frameMaterial: string | null;
  /** Canonical lens type label: "Polarized" or "UV400". */
  lensType: string | null;
  /** Canonical gender phrase: "Women", "Men", "Unisex". */
  genderPhrase: string | null;
  /** Up to ~6 style tag values (vintage, retro, casual, ...). */
  styleTags: string[];
  /** Distinct colors from the product's variants. */
  variantColors: string[];
  /** Existing long-form description (may be null/empty — used as tone reference only). */
  existingDescription: string | null;
  /** Bullet points if present (raw text, not HTML). */
  existingBulletPoints: string | null;
  /**
   * Curated search keywords from the `keyword` tag dimension. These are
   * how real people search for this product. Pass up to ~30 — model picks
   * 3–5 to weave in naturally.
   */
  curatedKeywords: string[];
}

export interface AiSeoOutput {
  /** 50–130 chars, brand + name + shape + lens + category + gender phrase. */
  title: string;
  /** 400–900 chars, plain text, 1–2 paragraphs. */
  description: string;
  /** Which curated keywords actually got used (audit trail). */
  keywords_used: string[];
  /** Self-reported character counts (caller verifies). */
  char_count: { title: number; description: number };
}

/**
 * Trademark and brand-name terms that must never appear in our copy.
 * Wayfarer is Ray-Ban's trademark; the others are competitor brand names
 * that would mislead shoppers. Lower-cased; the prompt instructs the
 * model to avoid these in any case.
 */
const FORBIDDEN_TERMS = [
  // Trademarked product line names
  "wayfarer",
  "clubmaster",
  "erika",
  "justin",
  "andy",
  "predator",
  // Competitor brand names
  "ray-ban",
  "rayban",
  "ray ban",
  "persol",
  "oakley",
  "gucci",
  "prada",
  "dior",
  "tom ford",
  "celine",
  "saint laurent",
  "ysl",
  "versace",
  "chanel",
  "miu miu",
  "fendi",
  "balenciaga",
  "bottega",
  "maui jim",
  "warby parker",
  "quay",
  // Pricing/quality words we don't use
  "cheap",
  "discount",
  "bargain",
  "knock-off",
  "knockoff",
  "dupe",
  "imitation",
];

const SYSTEM_PROMPT = `\
You are a Google Shopping SEO copywriter for Jaxy, a fashion sunglasses
and eyewear brand. You write for people searching Google for sunglasses,
optical glasses, or reading glasses. Your goal is to write titles that
maximize click-through rate from search results and descriptions that
convert browsers into buyers.

You always follow Google Shopping's published best practices.

TITLE RULES — never break:
- 50 to 130 characters. Target 70–90.
- Include in roughly this order: product name, frame shape, lens type,
  category (Sunglasses / Optical Glasses / Reading Glasses), and an
  optional gender phrase ("for Women", "for Men", "Unisex").
- The brand "Jaxy" should appear ONCE — usually toward the end as a
  signature, not at the start. Jaxy is not yet well-known so leading
  with the product attributes that match search intent is more important.
- Use natural search phrasing ("for Women" not "Womens", "Cat-Eye" not
  "Cat Eye" or "cateye").
- No emoji, no ALL CAPS words, no exclamation marks, no "Best", no
  "Premium", no "Top-rated", no "Free Shipping", no sale/discount
  language.
- Em-dash ( — ) is fine to separate name from descriptors.
- No SKU codes, no internal model numbers, no parenthetical asides.

DESCRIPTION RULES — never break:
- 400 to 900 characters. Target 600.
- The first 160 characters are the mobile preview — lead with the most
  important benefit + shape + lens type.
- 1 to 2 short paragraphs maximum.
- Plain text only. No HTML, no bullet points, no markdown.
- Reuse 2–3 of the title's keywords naturally (don't keyword-stuff).
- Mention frame shape, lens type with UV protection, available colors,
  target gender if relevant, frame material if known, and 1–2 style
  adjectives. Mention "Jaxy" at most once; don't open with the brand.
- End with a benefit sentence, NOT a CTA. "Shop now", "Buy today",
  "Order yours" are forbidden.
- Do NOT claim warranty, free returns, free shipping, lifetime
  guarantees, or anything similar — those aren't promises we make.

WORDS YOU MUST NEVER USE (any case):
- Trademarked product line names: Wayfarer, Clubmaster, Erika, Justin,
  Andy, Predator (these are competitor product line trademarks).
- Competitor brand names: Ray-Ban, Persol, Oakley, Gucci, Prada, Dior,
  Tom Ford, Celine, Saint Laurent, YSL, Versace, Chanel, Miu Miu,
  Fendi, Balenciaga, Bottega, Maui Jim, Warby Parker, Quay.
- Pricing/quality words: cheap, discount, bargain, knock-off, knockoff,
  dupe, imitation.
- Promotional fluff: best, premium, top-rated, must-have, perfect.

OUTPUT FORMAT — strict JSON, no surrounding prose, no markdown fences:
{
  "title": "...",
  "description": "...",
  "keywords_used": ["..."],
  "char_count": { "title": N, "description": N }
}
`;

function buildUserMessage(input: AiSeoInput): string {
  const lines: string[] = [];
  lines.push("Generate SEO copy for this Jaxy product:");
  lines.push("");
  lines.push("PRODUCT");
  lines.push(`  Name: ${input.name}`);
  lines.push(`  SKU prefix: ${input.skuPrefix}`);
  lines.push(`  Category: ${input.category}`);
  if (input.frameShape) lines.push(`  Frame shape: ${input.frameShape}`);
  if (input.frameMaterial) lines.push(`  Frame material: ${input.frameMaterial}`);
  if (input.lensType) lines.push(`  Lens type: ${input.lensType}`);
  if (input.genderPhrase) lines.push(`  Gender phrase: ${input.genderPhrase}`);
  lines.push("");

  if (input.styleTags.length > 0) {
    lines.push("STYLE TAGS (use 1–2 in the description, not in the title):");
    lines.push(`  ${input.styleTags.join(", ")}`);
    lines.push("");
  }

  if (input.variantColors.length > 0) {
    lines.push("AVAILABLE COLORS (variants):");
    lines.push(`  ${input.variantColors.join(", ")}`);
    lines.push("");
  }

  if (input.existingDescription && input.existingDescription.trim()) {
    lines.push("EXISTING DESCRIPTION (tone reference only — paraphrase, do not quote verbatim):");
    lines.push(`  "${truncate(input.existingDescription, 600)}"`);
    lines.push("");
  }

  if (input.existingBulletPoints && input.existingBulletPoints.trim()) {
    lines.push("EXISTING BULLET POINTS (use as feature hints, do not list as bullets in output):");
    lines.push(`  ${truncate(input.existingBulletPoints, 400)}`);
    lines.push("");
  }

  if (input.curatedKeywords.length > 0) {
    // Trim to top 30 — more than that overwhelms the model and adds little.
    const top = input.curatedKeywords.slice(0, 30);
    lines.push("CURATED SEARCH KEYWORDS (incorporate 3–5 naturally; do NOT list them):");
    lines.push(`  ${top.join("; ")}`);
    lines.push("");
  }

  lines.push("Return strict JSON matching the schema in your instructions. No prose around it.");
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** Returns the (system, user) pair to send to Claude. */
export function buildSeoPrompt(input: AiSeoInput): { system: string; user: string } {
  return { system: SYSTEM_PROMPT, user: buildUserMessage(input) };
}

/**
 * Validate AI output. Returns null if structurally invalid.
 * Returns warnings for soft violations (length, forbidden words).
 */
export function validateSeoOutput(raw: unknown): {
  output: AiSeoOutput | null;
  warnings: string[];
  errors: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== "object") {
    errors.push("output is not an object");
    return { output: null, errors, warnings };
  }
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === "string" ? r.title.trim() : "";
  const description = typeof r.description === "string" ? r.description.trim() : "";
  const keywords_used = Array.isArray(r.keywords_used)
    ? r.keywords_used.filter((x): x is string => typeof x === "string")
    : [];

  if (!title) errors.push("title missing");
  if (!description) errors.push("description missing");
  if (errors.length > 0) return { output: null, errors, warnings };

  // Soft length checks
  if (title.length < 50) warnings.push(`title is ${title.length} chars (target ≥50)`);
  if (title.length > 130) warnings.push(`title is ${title.length} chars (target ≤130)`);
  if (description.length < 400) warnings.push(`description is ${description.length} chars (target ≥400)`);
  if (description.length > 900) warnings.push(`description is ${description.length} chars (target ≤900)`);

  // Forbidden-word check (case-insensitive substring match)
  const haystack = `${title}\n${description}`.toLowerCase();
  const found = FORBIDDEN_TERMS.filter((t) => haystack.includes(t));
  if (found.length > 0) warnings.push(`contains forbidden terms: ${found.join(", ")}`);

  // Promotional fluff that we soft-flag (model usually obeys but spot-check)
  for (const fluff of ["!", "shop now", "buy now", "buy today", "order yours"]) {
    if (haystack.includes(fluff)) warnings.push(`contains discouraged phrase: "${fluff}"`);
  }

  return {
    output: {
      title,
      description,
      keywords_used,
      char_count: { title: title.length, description: description.length },
    },
    warnings,
    errors,
  };
}

export { FORBIDDEN_TERMS };
