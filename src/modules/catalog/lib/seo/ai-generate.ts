/**
 * Generate Google Shopping SEO copy for a single product via Claude.
 *
 * Reads the product's tags + curated attrs + variants and builds an
 * AiSeoInput from them. Calls Claude with the prompt module, parses
 * JSON, runs validation. Caller decides whether to save the result.
 */
import { db } from "@/lib/db";
import { products, skus as skusTable, tags as tagsTable } from "@/modules/catalog/schema";
import { eq } from "drizzle-orm";
import { curatedAttrsFromTags } from "@/modules/catalog/lib/curated-attributes";
import {
  buildSeoPrompt,
  validateSeoOutput,
  type AiSeoInput,
  type AiSeoOutput,
} from "./google-shopping-prompt";

/**
 * Default model. Override via SEO_AI_MODEL env var. Use Opus for the
 * bulk run because the user explicitly asked for the best quality —
 * this is one-shot copy that ships to a Google ads feed, slow + costly
 * is the right tradeoff vs. having to manually fix bad copy later.
 */
const DEFAULT_MODEL = "claude-opus-4-1-20250805";

export interface GenerateSeoResult {
  output: AiSeoOutput | null;
  errors: string[];
  warnings: string[];
  /** Model identifier used for the call. */
  model: string;
  /** Raw text returned by Claude (kept for debugging — not surfaced in UI). */
  rawText?: string;
}

/** Map a curated gender tag to a search-friendly phrase. */
function genderPhrase(g: string | null): string | null {
  if (!g) return null;
  const v = g.trim().toLowerCase();
  if (["female", "women", "womens", "ladies"].includes(v)) return "Women";
  if (["male", "men", "mens"].includes(v)) return "Men";
  if (["unisex", "uni"].includes(v)) return "Unisex";
  if (["non-binary", "nonbinary"].includes(v)) return null;
  return null;
}

/** Title-case a "cat-eye" / "round" / etc. for prompt readability. */
function prettyShape(s: string | null): string | null {
  if (!s) return null;
  const v = s.trim().toLowerCase();
  if (v === "cat-eye" || v === "cateye") return "Cat-Eye";
  return v.charAt(0).toUpperCase() + v.slice(1);
}

function prettyCategory(c: string | null): string {
  if (!c) return "Sunglasses";
  const v = c.trim().toLowerCase();
  if (v === "optical") return "Optical Glasses";
  if (v === "reading") return "Reading Glasses";
  return "Sunglasses";
}

function prettyLensType(t: string | null): string | null {
  if (!t) return null;
  const v = t.trim().toLowerCase();
  if (v === "polarized") return "Polarized";
  if (v === "uv400" || v === "non-polarized") return "UV400";
  return null;
}

/** Build the AI input from this product's DB rows. */
async function buildInput(productId: string): Promise<AiSeoInput | null> {
  const product = (await db.select().from(products).where(eq(products.id, productId)))[0];
  if (!product) return null;

  const tagRows = await db.select().from(tagsTable).where(eq(tagsTable.productId, productId));
  const skuRows = await db
    .select({ colorName: skusTable.colorName })
    .from(skusTable)
    .where(eq(skusTable.productId, productId));

  const curated = curatedAttrsFromTags(tagRows);

  // Style tags — top 6 to keep prompt focused
  const styleTags = tagRows
    .filter((t) => (t.dimension ?? "").toLowerCase() === "style")
    .map((t) => (t.tagName ?? "").trim())
    .filter((v): v is string => v.length > 0)
    .slice(0, 6);

  // Curated keywords — top 30, deduped, dropping anything that contains
  // forbidden trademark/brand words so the model can't accidentally
  // surface them.
  const keywordRaw = tagRows
    .filter((t) => (t.dimension ?? "").toLowerCase() === "keyword")
    .map((t) => (t.tagName ?? "").trim())
    .filter((v): v is string => v.length > 0);
  const seen = new Set<string>();
  const curatedKeywords: string[] = [];
  for (const kw of keywordRaw) {
    const lower = kw.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    // Drop keywords containing trademark/brand names — the user has these
    // for SEO research purposes but we should never put them in copy.
    const forbidden = [
      "ray-ban", "rayban", "ray ban", "persol", "oakley", "gucci", "prada",
      "dior", "tom ford", "celine", "saint laurent", "ysl", "versace",
      "chanel", "miu miu", "fendi", "balenciaga", "bottega", "maui jim",
      "warby parker", "quay", "wayfarer", "clubmaster",
      // Pricing
      "cheap", "discount", "bargain",
    ];
    if (forbidden.some((f) => lower.includes(f))) continue;
    curatedKeywords.push(kw);
  }

  // Distinct color names from variants, in order
  const colorSeen = new Set<string>();
  const variantColors: string[] = [];
  for (const s of skuRows) {
    if (!s.colorName) continue;
    const k = s.colorName.toLowerCase();
    if (colorSeen.has(k)) continue;
    colorSeen.add(k);
    variantColors.push(s.colorName);
  }

  return {
    name: product.name ?? product.skuPrefix ?? "",
    skuPrefix: product.skuPrefix ?? "",
    category: prettyCategory(curated.category),
    frameShape: prettyShape(curated.frameShape),
    frameMaterial: curated.frameMaterial,
    lensType: prettyLensType(curated.lensType),
    genderPhrase: genderPhrase(curated.gender),
    styleTags,
    variantColors,
    existingDescription: product.description,
    existingBulletPoints: product.bulletPoints,
    curatedKeywords,
  };
}

/** Call Anthropic's messages API with the SEO prompt. */
async function callClaude(
  system: string,
  user: string,
  model: string,
): Promise<{ rawText: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  const block = json.content.find((c) => c.type === "text");
  return { rawText: block?.text ?? "" };
}

/** Strip markdown code fences from the raw text if Claude wrapped output. */
function unwrapJson(text: string): string {
  const trimmed = text.trim();
  // ```json ... ``` or ``` ... ```
  const fence = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fence) return fence[1].trim();
  return trimmed;
}

/**
 * Generate SEO for one product. Doesn't save anywhere; caller decides
 * what to do with the result.
 */
export async function generateSeoForProduct(
  productId: string,
  modelOverride?: string,
): Promise<GenerateSeoResult> {
  const model = modelOverride || process.env.SEO_AI_MODEL || DEFAULT_MODEL;
  const input = await buildInput(productId);
  if (!input) {
    return { output: null, errors: [`product ${productId} not found`], warnings: [], model };
  }

  const { system, user } = buildSeoPrompt(input);

  let rawText = "";
  try {
    const r = await callClaude(system, user, model);
    rawText = r.rawText;
  } catch (e) {
    return {
      output: null,
      errors: [`Claude call failed: ${e instanceof Error ? e.message : "unknown"}`],
      warnings: [],
      model,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapJson(rawText));
  } catch (e) {
    return {
      output: null,
      errors: [`failed to parse JSON: ${e instanceof Error ? e.message : "unknown"}`],
      warnings: [],
      model,
      rawText,
    };
  }

  const v = validateSeoOutput(parsed);
  return { output: v.output, errors: v.errors, warnings: v.warnings, model, rawText };
}
