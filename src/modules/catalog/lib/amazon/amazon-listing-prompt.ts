/**
 * Amazon listing prompt — vision-enabled. Drives Claude (Opus 4.1) with
 * product images plus keyword research + tags to produce the title,
 * 5 bullet points, product description, generic_keywords, and suggested
 * Amazon enum values that the column-mapper consumes.
 *
 * Modeled on src/modules/catalog/lib/seo/google-shopping-prompt.ts —
 * same FORBIDDEN_TERMS list, same JSON-only output discipline, same
 * validateXxxOutput shape — but the messages array carries
 * { type: "image", source: { type: "url", url } } blocks so Claude can
 * see the actual product photos. Vision input is what unlocks accurate
 * suggested_color_map / suggested_frame_material / suggested_item_shape
 * picks — tag-derived defaults handle the easy cases but get fooled on
 * marbled / tortoise / multi-tone frames where a literal look at the
 * photo is the only reliable signal.
 */

import { FORBIDDEN_TERMS as SEO_FORBIDDEN_TERMS } from "@/modules/catalog/lib/seo/google-shopping-prompt";
import { getEnumValues } from "./template-snapshot";
import { AMAZON_COLOR_MAP_VALUES } from "./color-map";

/** Bump whenever the prompt or output schema changes — stamped on every
 *  row written to catalog_amazon_listings so we can re-run the
 *  pipeline when copy drifts behind the latest revision. */
export const PROMPT_VERSION = "amazon-v1.2-2026-06-10";

// ── Input/output schemas ─────────────────────────────────────────────────

export interface AmazonListingInput {
  /** Product name (e.g. "Jaxy Cat-Eye Polarized Sunglasses"). */
  productName: string;
  /** SKU prefix shown to the model for context only. */
  skuPrefix: string;
  /** "sunglasses" / "optical" / "reading" — drives copy emphasis. */
  category: "sunglasses" | "optical" | "reading" | null;
  /** Curated frame shape ("cat-eye", "round", "rectangle", …). */
  frameShape: string | null;
  /** Curated frame material ("acetate", "metal", …). */
  frameMaterial: string | null;
  /** Curated gender ("women", "men", "unisex"). */
  gender: string | null;
  /** Polarized / UV400 etc. */
  lensType: string | null;
  /**
   * Ranked, brand-scrubbed keyword pools from the per-product assembler
   * (keywords/assemble.ts), keyed off the product's frame shape(s).
   * - head:    generic high-volume terms to front-load in the title
   * - shape:   shape-specific terms for the title + bullets
   * - feature: feature terms (polarized, uv400) for the bullets
   * - backend: ready-made generic_keywords string (≤240 bytes, deduped
   *            against title/bullets) — copied verbatim by the prompt.
   */
  keywordSet: {
    head: string[];
    shape: string[];
    feature: string[];
    backend: string;
  };
  /** Comma-separated colour names across the SKUs. */
  availableColors: string[];
  /** HTTPS image URLs (Shopify CDN). First = hero. */
  imageUrls: string[];
  /** Existing description text as inspiration — model may reuse but must
   *  not copy verbatim because it's not Amazon-optimised. */
  existingDescription: string | null;
  /** Physical frame dimensions in millimetres, from the factory's
   *  "51口22 145" string. When present, we pass them through so Claude
   *  doesn't have to infer from photos AND so they can be written into
   *  the listing body. The Amazon template already declares matching
   *  numeric columns (lens_width/bridge_width/temple_length/lens_height
   *  with lens_unit="millimeters"); column-mapper.ts writes the cells. */
  lensWidth: number | null;
  bridgeWidth: number | null;
  templeLength: number | null;
  lensHeight: number | null;
  /** Total frame width edge-to-edge (mm); 5-field factories supply it. */
  frameWidth: number | null;
}

export interface AmazonListingOutput {
  /** Amazon item_name. ≤200 chars; aim for keyword-rich front-loaded copy. */
  title: string;
  /** Exactly 5 bullets, ≤500 chars each, no leading bullet glyph. */
  bullet_points: [string, string, string, string, string];
  /** Amazon product_description. Plain text; line breaks ok; no HTML. */
  description: string;
  /** Space-delimited search terms, ≤240 bytes. */
  generic_keywords: string;
  /** Picked from AMAZON_COLOR_MAP_VALUES (20 values). The model sees the
   *  hero image so it can override tag-derived defaults on multi-tone
   *  frames. Returns "Multicolor" when no single colour dominates. */
  suggested_color_map: string;
  /** From lens_material_type enum. */
  suggested_lens_material: string;
  /** From frame_material_type enum. */
  suggested_frame_material: string;
  /** From polarization_type enum. */
  suggested_polarization: string;
  /** From item_shape enum. */
  suggested_item_shape: string;
  /** Self-reported character counts so we can double-check vs the body. */
  char_count: {
    title: number;
    bullets: number[];
    description: number;
    generic_keywords: number;
  };
}

// ── System prompt ────────────────────────────────────────────────────────

/**
 * Lazy-built so we can interpolate the live enum values from the snapshot
 * at module init. We freeze the prompt content here (caller doesn't pass
 * enums in) — Claude reads them as part of the system instructions.
 */
function buildSystemPrompt(): string {
  const lensColorMap = AMAZON_COLOR_MAP_VALUES.join(" | ");
  const frameMaterials = (getEnumValues("frame_material_type") ?? []).join(" | ");
  const lensMaterials = (getEnumValues("lens_material_type") ?? []).join(" | ");
  const polarization = (getEnumValues("polarization_type") ?? []).join(" | ");
  const itemShapes = (getEnumValues("item_shape") ?? []).slice(0, 20).join(" | ");

  return `\
You are an Amazon SEO copywriter for Jaxy, a fashion sunglasses and eyewear
brand. You write listings that maximise organic ranking on Amazon's search
engine A9 and convert browse traffic into add-to-cart. You will see the
actual product photographs along with curated keyword research; ground all
copy decisions in what is visibly true in the images.

OUTPUT FORMAT — strict JSON only, no prose, no code fences:
{
  "title": "…",
  "bullet_points": ["…", "…", "…", "…", "…"],
  "description": "…",
  "generic_keywords": "…",
  "suggested_color_map": "…",
  "suggested_lens_material": "…",
  "suggested_frame_material": "…",
  "suggested_polarization": "…",
  "suggested_item_shape": "…",
  "char_count": { "title": 0, "bullets": [0,0,0,0,0], "description": 0, "generic_keywords": 0 }
}

TITLE RULES — never break:
- ≤50 chars HARD CAP. Amazon's sunglasses template item_name field is
  strictly 50 chars. Titles above 50 are rejected at upload time, so
  keep this tight. Target 40–50 chars.
- Front-load the 1–2 highest-intent keywords: shape + category + a
  qualifier. END the title with the brand + style name: "| Jaxy <Style>".
  If that doesn't fit in 50, drop the style name and end with "Jaxy".
  Examples (all under 50):
    "Cat Eye Polarized Sunglasses Women | Jaxy Velour"  (48)
    "Round Polarized Sunglasses | Jaxy Havana Haze"     (45)
    "Polarized Aviator Sunglasses | Jaxy Horizon"       (43)
- Natural phrasing ("for Women" not "Womens"; "Cat-Eye" not "cateye").
- No promotional language ("Best", "Premium", "Top-rated", "Sale",
  "Discount", "Free Shipping"), no ALL CAPS words, no emoji, no
  exclamation marks, no SKU codes, no model numbers.
- No "®", "©", or "™" characters anywhere — Amazon rejects high-ASCII.

BULLET POINT RULES — exactly 5 bullets:
- ≤500 chars each. Target 150–300.
- Lead each bullet with a 1–3 word benefit phrase in Title Case followed
  by ":" and the explanation. Example: "Polarized UV400 Lenses: Block
  100% of UVA + UVB rays while cutting road and water glare for crisp
  clarity."
- Bullets cover, in order: (1) lens technology, (2) frame shape + fit +
  lightweight, (3) styling + occasion versatility, (4) included
  protective case, (5) brand promise / Jaxy quality.

PRODUCT FACT RULES — never break:
- LENS CLAIM: each product is EITHER Polarized OR UV400 — never both.
  Claim only the lens type given in the user message. If it says
  Polarized, do not also claim UV400 (and vice versa). If unknown,
  say "sun protection" generically.
- FRAME MATERIAL: never name a frame material (acetate, metal, TR90,
  plastic, etc.) in the title, bullets, or description — even if the
  context suggests one. Describe feel instead: "lightweight",
  "hand-finished", "sturdy hinges".
- ACCESSORIES: a protective carrying case IS included. A cleaning
  cloth is NOT — never mention a cloth.
- No bullets that start with the bullet glyph (•) — Amazon adds those.
- No "®", "©", "™".

DESCRIPTION RULES:
- 800–1800 chars. Plain text; line breaks allowed; no HTML.
- 2–3 short paragraphs. First sentence = mobile preview = lead benefit.
- Reuse 3–4 high-intent keywords from the title naturally — no stuffing.
- End with a benefit sentence, never a CTA ("Shop now" forbidden).
- Do NOT claim warranty, lifetime guarantee, or free returns/shipping.

GENERIC_KEYWORDS:
- The user message provides a ready-made BACKEND SEARCH STRING. Copy it
  VERBATIM into generic_keywords — it is already lowercase, deduped
  against the title/bullets, and within Amazon's byte budget. Do not add,
  reorder, or remove tokens.

SUGGESTED_* — must be literal enum values:
- suggested_color_map ∈ ${lensColorMap}
- suggested_frame_material ∈ ${frameMaterials}
- suggested_lens_material ∈ ${lensMaterials}
- suggested_polarization ∈ ${polarization}
- suggested_item_shape ∈ ${itemShapes}…

Use the IMAGES to pick suggested_*. If the photo shows a marbled or
tortoise pattern, suggested_color_map = "Brown" (Amazon's accepted
mapping). If the lens has a mirrored coating, suggested_polarization
= "Mirrored". If the frame mixes metal and plastic, pick the dominant
material. Do not invent enum values — return the closest exact match.

WORDS YOU MUST NEVER USE (any case):
${SEO_FORBIDDEN_TERMS.map((t) => `- ${t}`).join("\n")}

Return ONLY the JSON object. No preamble, no explanation, no markdown.`;
}

const SYSTEM_PROMPT = buildSystemPrompt();

// ── Message construction ────────────────────────────────────────────────

interface AnthropicImageBlock {
  type: "image";
  source: { type: "url"; url: string };
}
interface AnthropicTextBlock {
  type: "text";
  text: string;
}
type AnthropicContentBlock = AnthropicImageBlock | AnthropicTextBlock;

/**
 * Build the structured content blocks for the user message. Returns the
 * Anthropic Messages API shape directly so the orchestrator can hand it
 * straight into fetch().
 *
 * Optional `repairIssues` adds a "FIX THESE FROM PREVIOUS ATTEMPT"
 * section near the top so the model treats them as hard constraints,
 * not gentle nudges. Passed by the auto-fix path from the validation
 * dialog.
 */
export function buildAmazonListingPrompt(
  input: AmazonListingInput,
  opts?: { repairIssues?: string[] },
): {
  system: string;
  messages: Array<{ role: "user"; content: AnthropicContentBlock[] }>;
} {
  const blocks: AnthropicContentBlock[] = [];

  // Cap image count to 8 to keep token cost sane (Claude vision is
  // priced per image). Hero first.
  for (const url of input.imageUrls.slice(0, 8)) {
    blocks.push({ type: "image", source: { type: "url", url } });
  }

  // Concise context block — Claude does better with structured cues than
  // prose paragraphs at vision-task scale.
  const lines: string[] = [];

  // Repair section first so the model treats these as overrides rather
  // than discovering the constraints mid-task.
  if (opts?.repairIssues && opts.repairIssues.length > 0) {
    lines.push("⚠️ FIX THESE FROM PREVIOUS ATTEMPT — these took the listing");
    lines.push("from blocked → must produce a release-ready row this time:");
    for (const issue of opts.repairIssues) {
      lines.push(`  • ${issue}`);
    }
    lines.push("");
  }

  lines.push(`Product: ${input.productName}`);
  lines.push(`SKU prefix: ${input.skuPrefix}`);
  lines.push(`Category: ${input.category ?? "(unspecified)"}`);
  lines.push(`Frame shape: ${input.frameShape ?? "(unknown — infer from images)"}`);
  lines.push(`Frame material: ${input.frameMaterial ?? "(unknown — infer from images)"}`);
  lines.push(`Lens type: ${input.lensType ?? "(unknown — infer from images)"}`);
  lines.push(`Gender: ${input.gender ?? "unisex"}`);
  lines.push(`Available colours across SKUs: ${input.availableColors.length ? input.availableColors.join(", ") : "(none)"}`);

  // Frame dimensions — verbatim from the factory's measurement string,
  // when present. Useful for the listing body (sizing copy) and saves
  // Claude having to infer from photos.
  if (input.lensWidth && input.bridgeWidth && input.templeLength) {
    const extras: string[] = [];
    if (input.lensHeight) extras.push(`lens height ${input.lensHeight} mm`);
    if (input.frameWidth) extras.push(`total frame width ${input.frameWidth} mm`);
    const extraSuffix = extras.length ? `, ${extras.join(", ")}` : "";
    lines.push(
      `Dimensions: ${input.lensWidth}-${input.bridgeWidth}-${input.templeLength} mm (lens width − bridge width − temple length${extraSuffix}). Reference these as a "size" callout in the bullets or description when natural.`,
    );
  }

  const ks = input.keywordSet;
  if (ks.head.length || ks.shape.length || ks.feature.length) {
    lines.push("");
    lines.push("KEYWORD RESEARCH — ranked by real Amazon search volume, brand-scrubbed:");
    if (ks.head.length) {
      lines.push("Head terms (highest volume — front-load 1–2 in the TITLE):");
      for (const k of ks.head) lines.push(`  - ${k}`);
    }
    if (ks.shape.length) {
      lines.push("Shape terms (work into the title + bullets — this is what differentiates this product):");
      for (const k of ks.shape) lines.push(`  - ${k}`);
    }
    if (ks.feature.length) {
      lines.push("Feature terms (use in bullets where true to the product):");
      for (const k of ks.feature) lines.push(`  - ${k}`);
    }
  }
  if (ks.backend) {
    lines.push("");
    lines.push("BACKEND SEARCH STRING — copy VERBATIM into generic_keywords (already");
    lines.push("deduped against title/bullets and within the byte budget; do not edit):");
    lines.push(ks.backend);
  }

  if (input.existingDescription) {
    lines.push("");
    lines.push("Existing description (inspiration only — DO NOT copy verbatim):");
    lines.push(input.existingDescription);
  }

  lines.push("");
  lines.push("Generate the Amazon listing per the system rules. Return JSON only.");

  blocks.push({ type: "text", text: lines.join("\n") });

  return {
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: blocks }],
  };
}

// ── Group-level listing (Phase 2 of group-restructure) ─────────────────
// Used to generate ONE Amazon parent listing per shape group, replacing
// per-product generation. Children stay per-product; the group's copy
// covers them all generically.

/** Per-style summary for the group prompt — Claude sees the dominant
 *  vibe of each style and chooses copy that flatters the whole set. */
export interface AmazonGroupStyleSummary {
  productName: string;
  skuPrefix: string;
  /** First (hero) image URL of this style — Claude uses these to
   *  ground colour, frame finish, lens tint observations in reality. */
  heroImageUrl: string | null;
  /** Frame colour names available for this style (across SKUs). */
  colors: string[];
  /** "polarized" or "uv400" — drives feature claims. Per the parent
   *  inheritance rule, the group may mix; the prompt tells Claude to
   *  use "Polarized or UV400" generically when mixed. */
  lensType: string | null;
}

export interface AmazonGroupListingInput {
  /** Canonical group identity — e.g. "aviator", "round". */
  groupKey: string;
  /** Capitalised display name for the group (e.g. "Round"). */
  shapeDisplay: string;
  /** Styles in the group, including the chosen representative (first). */
  styles: AmazonGroupStyleSummary[];
  /** Curated frame material — backfilled as "acetate" or "metal" via
   *  scripts/backfill-amazon-group-key.ts. The dominant value for the
   *  group; per-child rows can still override at row-composition time. */
  dominantFrameMaterial: string | null;
  /** "Polarized" / "UV400" / "Polarized or UV400" — what the parent
   *  listing claims at the title level. The orchestrator computes
   *  this from the group's actual mix. */
  polarizationClaim: string;
  /** Curated keyword research across the group (deduped). */
  keywords: string[];
}

export interface AmazonGroupListingOutput {
  /** Amazon item_name for the GROUP parent. ≤200 chars (parent rows
   *  have a generous limit; only children inherit the 50-char cap).
   *  Per Amazon's template warning, MUST NOT contain individual style
   *  names, colours, or per-child variant detail. */
  title: string;
  /** 5 bullets describing the COLLECTION, not specific styles. */
  bullet_points: [string, string, string, string, string];
  /** Group description. Plain text; line breaks ok; no HTML. Mentions
   *  the number of styles + key shapes within the group, treating the
   *  set as a curated collection rather than one product. */
  description: string;
  /** Space-delimited search terms, ≤240 bytes. Covers the entire
   *  group's keyword surface — shape + multiple style synonyms. */
  generic_keywords: string;
  /** suggested_frame_material at the GROUP level — dominant material. */
  suggested_frame_material: string;
  /** suggested_polarization at the GROUP level — picks the dominant
   *  claim, children can override. */
  suggested_polarization: string;
  /** Self-reported character counts for cross-checking. */
  char_count: {
    title: number;
    bullets: number[];
    description: number;
    generic_keywords: number;
  };
}

function buildGroupSystemPrompt(): string {
  const frameMaterials = (getEnumValues("frame_material_type") ?? []).join(" | ");
  const polarization = (getEnumValues("polarization_type") ?? []).join(" | ");

  return `\
You are an Amazon SEO copywriter for Jaxy, a fashion sunglasses brand.
You are writing the PARENT listing for a SHAPE COLLECTION — multiple
styles share this listing with each colour/style appearing as a child
variant. The parent's title and bullets must read as a collection
overview, NEVER as a single product.

CRITICAL: per Amazon's variation guidelines —
"Parent SKU titles should never contain size or color information as
they represent the entire SKU family, not any specific size or color."

OUTPUT FORMAT — strict JSON only, no prose, no code fences:
{
  "title": "…",
  "bullet_points": ["…", "…", "…", "…", "…"],
  "description": "…",
  "generic_keywords": "…",
  "suggested_frame_material": "…",
  "suggested_polarization": "…",
  "char_count": { "title": 0, "bullets": [0,0,0,0,0], "description": 0, "generic_keywords": 0 }
}

TITLE RULES — group parent:
- ≤140 chars HARD CAP. Parents have a more generous limit than children.
- Lead with the shape + category: "Round Polarized Sunglasses",
  "Aviator Sunglasses for Women", etc.
- Mention the brand "Jaxy" once if it fits.
- Reference the GROUP nature when natural: "Round Sunglasses
  Collection by Jaxy", "Polarized Aviator Sunglasses Set" — but DO
  NOT name individual styles (Havana Haze, Monroe, etc.).
- NO colour names ("Tortoise", "Black", "Sand") — those live on the
  children.
- No promotional language, no ALL CAPS, no emoji, no SKU codes.

BULLET POINT RULES — exactly 5 bullets, ≤500 chars each:
- Describe the COLLECTION'S attributes — lens technology, frame
  material, fit, occasion versatility, brand promise — not a single
  pair of glasses.
- It's OK to say "the collection includes X distinct silhouettes" or
  "choose from N curated styles" — count comes from the user input.
- Use "each pair" or "every frame" when describing a feature shared by
  all children.
- Never name individual styles in the bullets.

DESCRIPTION RULES:
- 800–1800 chars. Plain text; line breaks allowed; no HTML.
- 2–3 short paragraphs. First sentence: collection-level lead benefit.
- Reuse 3–4 high-intent keywords from the title naturally.
- End with a benefit sentence, never a CTA.

GENERIC_KEYWORDS:
- ≤240 bytes. Space-delimited. All lowercase. No commas.
- Cover the breadth of the collection — shape synonyms, lens type,
  gender, era ("retro", "vintage" if applicable), use-case
  ("driving", "everyday").

SUGGESTED_* — must be literal enum values:
- suggested_frame_material ∈ ${frameMaterials}
- suggested_polarization ∈ ${polarization}

Use the IMAGES to validate that the colour palette and lens tints
described match what's actually in the photos.

WORDS YOU MUST NEVER USE (any case):
${SEO_FORBIDDEN_TERMS.map((t) => `- ${t}`).join("\n")}

Return ONLY the JSON object. No preamble, no explanation, no markdown.`;
}

const GROUP_SYSTEM_PROMPT = buildGroupSystemPrompt();

/**
 * Build the Anthropic message structure for a GROUP listing.
 * Sequences images from each style's hero photo so Claude can ground
 * its colour and silhouette claims in the actual product range.
 */
export function buildAmazonGroupListingPrompt(
  input: AmazonGroupListingInput,
  opts?: { repairIssues?: string[] },
): {
  system: string;
  messages: Array<{ role: "user"; content: AnthropicContentBlock[] }>;
} {
  const blocks: AnthropicContentBlock[] = [];

  // Take one hero image per style, capped at 8 (cost ceiling). The
  // first image in the list is the group's representative — per
  // Daniel's call, first product's hero photo.
  const heroes = input.styles
    .map((s) => s.heroImageUrl)
    .filter((url): url is string => !!url)
    .slice(0, 8);
  for (const url of heroes) {
    blocks.push({ type: "image", source: { type: "url", url } });
  }

  const lines: string[] = [];
  if (opts?.repairIssues && opts.repairIssues.length > 0) {
    lines.push("⚠️ FIX THESE FROM PREVIOUS ATTEMPT:");
    for (const issue of opts.repairIssues) lines.push(`  • ${issue}`);
    lines.push("");
  }

  lines.push(`Shape collection: ${input.shapeDisplay}`);
  lines.push(`Group key: ${input.groupKey}`);
  lines.push(`Styles in this collection: ${input.styles.length}`);
  lines.push(`Dominant frame material: ${input.dominantFrameMaterial ?? "(unspecified)"}`);
  lines.push(`Polarization claim: ${input.polarizationClaim}`);
  lines.push("");
  lines.push("Styles (do NOT name in copy, list provided for grounding only):");
  for (const s of input.styles) {
    const colorsPart = s.colors.length ? ` — colours: ${s.colors.join(", ")}` : "";
    lines.push(`  • ${s.productName} (${s.skuPrefix})${colorsPart}`);
  }

  if (input.keywords.length > 0) {
    lines.push("");
    lines.push("Keyword research across the group (use naturally, no stuffing):");
    for (const kw of input.keywords.slice(0, 12)) lines.push(`  - ${kw}`);
  }

  lines.push("");
  lines.push("Generate the GROUP-LEVEL Amazon listing per the system rules. Return JSON only.");
  blocks.push({ type: "text", text: lines.join("\n") });

  return {
    system: GROUP_SYSTEM_PROMPT,
    messages: [{ role: "user", content: blocks }],
  };
}

/**
 * Validate Claude's group-level JSON output. Mirrors
 * validateAmazonListingOutput() but applies the group-specific
 * length/forbidden-content rules.
 */
export function validateAmazonGroupListingOutput(raw: unknown): {
  output: AmazonGroupListingOutput | null;
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
  const genericKeywords = typeof r.generic_keywords === "string" ? r.generic_keywords.trim() : "";
  const bulletsRaw = Array.isArray(r.bullet_points) ? r.bullet_points : [];
  const bullets = bulletsRaw.map((b) => (typeof b === "string" ? b.trim() : "")).filter(Boolean);
  const frameMaterial = typeof r.suggested_frame_material === "string"
    ? r.suggested_frame_material.trim() : "";
  const polarization = typeof r.suggested_polarization === "string"
    ? r.suggested_polarization.trim() : "";

  if (!title) errors.push("title is missing");
  else if (title.length > 140) warnings.push(`title is ${title.length} chars (>140)`);
  if (!description) errors.push("description is missing");
  else if (description.length < 500) warnings.push(`description is short (${description.length} chars)`);
  if (bullets.length !== 5) errors.push(`bullet_points must be 5 items (got ${bullets.length})`);
  if (!genericKeywords) errors.push("generic_keywords is missing");
  else if (genericKeywords.length > 240) warnings.push(`generic_keywords is ${genericKeywords.length} chars (>240)`);

  // Forbidden content — group titles must NOT contain colour or style
  // names per Amazon variation rules.
  const FORBIDDEN_IN_TITLE = ["tortoise", "black", "blue", "brown", "green", "red", "amber"];
  const lowerTitle = title.toLowerCase();
  for (const banned of FORBIDDEN_IN_TITLE) {
    if (lowerTitle.includes(banned)) {
      warnings.push(`title contains colour word "${banned}" — parent titles must be colour-agnostic`);
    }
  }

  if (HIGH_ASCII_RE.test(title) || HIGH_ASCII_RE.test(description) ||
      bullets.some((b) => HIGH_ASCII_RE.test(b))) {
    errors.push("contains forbidden high-ASCII character (®, ©, or ™)");
  }

  if (errors.length > 0) return { output: null, errors, warnings };

  return {
    output: {
      title,
      bullet_points: bullets.slice(0, 5) as [string, string, string, string, string],
      description,
      generic_keywords: genericKeywords,
      suggested_frame_material: frameMaterial,
      suggested_polarization: polarization,
      char_count: {
        title: title.length,
        bullets: bullets.slice(0, 5).map((b) => b.length),
        description: description.length,
        generic_keywords: genericKeywords.length,
      },
    },
    warnings,
    errors,
  };
}

// ── Output validation ───────────────────────────────────────────────────

const HIGH_ASCII_RE = /[®©™]/;

/**
 * Validate Claude's JSON output. Returns null on structural failures;
 * soft issues (length, missing enum match) come back as warnings.
 */
export function validateAmazonListingOutput(raw: unknown): {
  output: AmazonListingOutput | null;
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
  const genericKeywords = typeof r.generic_keywords === "string" ? r.generic_keywords.trim() : "";
  const bulletsRaw = Array.isArray(r.bullet_points) ? r.bullet_points : [];
  const bullets = bulletsRaw.map((b) => (typeof b === "string" ? b.trim() : "")).filter(Boolean);

  if (!title) errors.push("title missing");
  if (!description) errors.push("description missing");
  if (bullets.length < 5) errors.push(`bullet_points must be exactly 5 (got ${bullets.length})`);

  // Enums — soft warn (we still persist; validator will block at download
  // time so ops can regenerate). Only check that the value is non-empty
  // and matches the snapshot enum case-insensitively.
  const requireEnum = (
    key: "suggested_color_map" | "suggested_lens_material" | "suggested_frame_material" | "suggested_polarization" | "suggested_item_shape",
    attr: string,
  ) => {
    const v = typeof r[key] === "string" ? (r[key] as string).trim() : "";
    if (!v) {
      warnings.push(`${key} missing`);
      return "";
    }
    const allowed = getEnumValues(attr);
    if (allowed && !allowed.includes(v) && !allowed.some((a) => a.toLowerCase() === v.toLowerCase())) {
      warnings.push(`${key} = "${v}" not in ${attr} enum`);
    }
    return v;
  };

  const suggested_color_map = requireEnum("suggested_color_map", "lens_color_map");
  const suggested_lens_material = requireEnum("suggested_lens_material", "lens_material_type");
  const suggested_frame_material = requireEnum("suggested_frame_material", "frame_material_type");
  const suggested_polarization = requireEnum("suggested_polarization", "polarization_type");
  const suggested_item_shape = requireEnum("suggested_item_shape", "item_shape");

  if (errors.length > 0) return { output: null, errors, warnings };

  // Length checks (soft — surface as warnings)
  if (title.length > 50) warnings.push(`title ${title.length} > 50 chars (will be hard-truncated for Amazon)`);
  if (title.length < 30) warnings.push(`title is short (${title.length} chars; target 40-50)`);
  for (let i = 0; i < bullets.length; i++) {
    if (bullets[i].length > 500) warnings.push(`bullet ${i + 1} ${bullets[i].length} > 500 chars`);
  }
  if (description.length > 2000) warnings.push(`description ${description.length} > 2000 chars`);
  if (genericKeywords.length > 240) warnings.push(`generic_keywords ${genericKeywords.length} > 240 bytes`);

  // High-ASCII (Amazon rejects)
  const haystack = [title, description, genericKeywords, ...bullets].join("\n");
  if (HIGH_ASCII_RE.test(haystack)) warnings.push("contains ®/©/™ — strip before persisting");

  // Forbidden terms — model usually obeys, but spot-check.
  const lower = haystack.toLowerCase();
  const found = SEO_FORBIDDEN_TERMS.filter((t) => lower.includes(t));
  if (found.length > 0) warnings.push(`forbidden terms found: ${found.join(", ")}`);

  return {
    output: {
      title,
      bullet_points: [bullets[0], bullets[1], bullets[2], bullets[3], bullets[4]] as [string, string, string, string, string],
      description,
      generic_keywords: genericKeywords,
      suggested_color_map,
      suggested_lens_material,
      suggested_frame_material,
      suggested_polarization,
      suggested_item_shape,
      char_count: {
        title: title.length,
        bullets: bullets.map((b) => b.length),
        description: description.length,
        generic_keywords: genericKeywords.length,
      },
    },
    warnings,
    errors,
  };
}
