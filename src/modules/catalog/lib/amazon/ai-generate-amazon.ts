/**
 * Orchestrator: take a productId, load everything Claude needs (tags,
 * SKUs, image URLs), call the vision API, validate output, persist to
 * catalog_amazon_listings + append an audit row to
 * catalog_copy_versions. Idempotent — re-running upserts.
 *
 * Mirrors src/modules/catalog/lib/seo/ai-generate.ts so the operational
 * pattern (env-driven model, structured error returns, no in-pipeline
 * thrown exceptions) matches what ops already knows.
 */
import { db, sqlite } from "@/lib/db";
import { products, skus, tags, copyVersions, amazonListings } from "@/modules/catalog/schema";
import { eq, inArray } from "drizzle-orm";
import { curatedAttrsFromTags } from "@/modules/catalog/lib/curated-attributes";
import {
  buildAmazonListingPrompt,
  validateAmazonListingOutput,
  PROMPT_VERSION,
  type AmazonListingInput,
  type AmazonListingOutput,
} from "./amazon-listing-prompt";
import { getShopifyImageUrls } from "./shopify-image-urls";

const DEFAULT_MODEL = "claude-opus-4-1-20250805";

export interface GenerateAmazonResult {
  productId: string;
  productName: string | null;
  output: AmazonListingOutput | null;
  errors: string[];
  warnings: string[];
  model: string;
  promptVersion: string;
  /** Whether the row was upserted into catalog_amazon_listings. */
  persisted: boolean;
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
}

/**
 * Make the Anthropic API call. Returns the JSON text Claude emitted.
 */
async function callClaudeVision(
  system: string,
  messages: ReturnType<typeof buildAmazonListingPrompt>["messages"],
  model: string,
): Promise<string> {
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
      max_tokens: 4000, // bigger than SEO — bullets + desc + suggested_*
      system,
      messages,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as AnthropicResponse;
  const block = json.content.find((c) => c.type === "text");
  return block?.text ?? "";
}

/** Strip ```json fences if Claude wrapped the output. */
function unwrapJson(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return fence ? fence[1].trim() : trimmed;
}

interface BuildInputResult {
  input: AmazonListingInput;
  productName: string | null;
}

/**
 * Load product + SKUs + tags + image URLs from the catalog and shape
 * them into the prompt input. Returns null if the product doesn't exist
 * so the caller can short-circuit cleanly.
 */
async function buildInput(productId: string): Promise<BuildInputResult | null> {
  const product = await db.select().from(products).where(eq(products.id, productId)).get();
  if (!product) return null;

  const allSkus = await db.select().from(skus).where(eq(skus.productId, productId));
  const allTags = await db.select().from(tags).where(eq(tags.productId, productId));

  const curated = curatedAttrsFromTags(
    allTags.map((t) => ({ tagName: t.tagName, dimension: t.dimension })),
  );

  const keywords = allTags
    .filter((t) => (t.dimension ?? "").toLowerCase() === "keyword")
    .map((t) => (t.tagName ?? "").trim())
    .filter(Boolean);

  const availableColors = Array.from(
    new Set(allSkus.map((s) => (s.colorName ?? "").trim()).filter(Boolean)),
  );

  // skuPrefix is the unique catalog code (e.g. "JX2001"). The schema marks
  // it nullable for legacy reasons, but in practice every approved product
  // has it. Fall back to empty string to keep TS happy — the orchestrator
  // upstream rejects products with no SKU prefix before they reach Claude.
  const skuPrefix = product.skuPrefix ?? "";

  const imageUrls = skuPrefix ? await getShopifyImageUrls(skuPrefix) : [];

  return {
    productName: product.name,
    input: {
      productName: product.name ?? skuPrefix,
      skuPrefix,
      category: curated.category,
      frameShape: curated.frameShape,
      frameMaterial: curated.frameMaterial,
      gender: curated.gender,
      lensType: curated.lensType,
      keywords,
      availableColors,
      imageUrls,
      existingDescription: product.description,
    },
  };
}

/**
 * Persist the validated AI output: upsert catalog_amazon_listings and
 * append an audit row to catalog_copy_versions (fieldName =
 * 'amazon_listing', content = serialised AmazonListingOutput).
 */
function persist(productId: string, output: AmazonListingOutput, model: string) {
  const now = new Date().toISOString();
  // Drizzle upsert by unique(productId).
  sqlite
    .prepare(
      `INSERT INTO catalog_amazon_listings (
        id, product_id, amazon_title,
        bullet_point_1, bullet_point_2, bullet_point_3, bullet_point_4, bullet_point_5,
        product_description, generic_keywords,
        suggested_color_map, suggested_lens_material, suggested_frame_material,
        suggested_polarization, suggested_item_shape,
        model_used, prompt_version, generated_at,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now')
      )
      ON CONFLICT(product_id) DO UPDATE SET
        amazon_title = excluded.amazon_title,
        bullet_point_1 = excluded.bullet_point_1,
        bullet_point_2 = excluded.bullet_point_2,
        bullet_point_3 = excluded.bullet_point_3,
        bullet_point_4 = excluded.bullet_point_4,
        bullet_point_5 = excluded.bullet_point_5,
        product_description = excluded.product_description,
        generic_keywords = excluded.generic_keywords,
        suggested_color_map = excluded.suggested_color_map,
        suggested_lens_material = excluded.suggested_lens_material,
        suggested_frame_material = excluded.suggested_frame_material,
        suggested_polarization = excluded.suggested_polarization,
        suggested_item_shape = excluded.suggested_item_shape,
        model_used = excluded.model_used,
        prompt_version = excluded.prompt_version,
        generated_at = excluded.generated_at,
        updated_at = datetime('now')`,
    )
    .run(
      crypto.randomUUID(),
      productId,
      output.title,
      output.bullet_points[0], output.bullet_points[1], output.bullet_points[2],
      output.bullet_points[3], output.bullet_points[4],
      output.description,
      output.generic_keywords,
      output.suggested_color_map,
      output.suggested_lens_material,
      output.suggested_frame_material,
      output.suggested_polarization,
      output.suggested_item_shape,
      model,
      PROMPT_VERSION,
      now,
    );

  // Audit: full output snapshot per regeneration. catalog_copy_versions
  // already exists with (id, productId, fieldName, content, aiModel,
  // createdAt). Drizzle insert (don't bother with the orm here — raw is
  // fine and matches the rest of this file).
  db.insert(copyVersions).values({
    productId,
    fieldName: "amazon_listing",
    content: JSON.stringify(output),
    aiModel: model,
  }).run();
}

/**
 * Generate Amazon listing copy for one product. Soft-failure shape — the
 * batch caller wants to keep going on individual errors.
 */
export async function generateAmazonListing(
  productId: string,
  opts?: { dryRun?: boolean; modelOverride?: string },
): Promise<GenerateAmazonResult> {
  const model = opts?.modelOverride || process.env.AMAZON_AI_MODEL || DEFAULT_MODEL;

  const built = await buildInput(productId);
  if (!built) {
    return {
      productId,
      productName: null,
      output: null,
      errors: [`product ${productId} not found`],
      warnings: [],
      model,
      promptVersion: PROMPT_VERSION,
      persisted: false,
    };
  }

  if (built.input.imageUrls.length === 0) {
    return {
      productId,
      productName: built.productName,
      output: null,
      errors: ["no Shopify CDN image URLs available — listing needs photos for vision generation"],
      warnings: [],
      model,
      promptVersion: PROMPT_VERSION,
      persisted: false,
    };
  }

  const { system, messages } = buildAmazonListingPrompt(built.input);

  let rawText = "";
  try {
    rawText = await callClaudeVision(system, messages, model);
  } catch (e) {
    return {
      productId,
      productName: built.productName,
      output: null,
      errors: [`Claude call failed: ${e instanceof Error ? e.message : String(e)}`],
      warnings: [],
      model,
      promptVersion: PROMPT_VERSION,
      persisted: false,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapJson(rawText));
  } catch (e) {
    return {
      productId,
      productName: built.productName,
      output: null,
      errors: [`output is not valid JSON: ${e instanceof Error ? e.message : "parse error"}`],
      warnings: [],
      model,
      promptVersion: PROMPT_VERSION,
      persisted: false,
    };
  }

  const { output, errors, warnings } = validateAmazonListingOutput(parsed);
  if (!output) {
    return {
      productId,
      productName: built.productName,
      output: null,
      errors,
      warnings,
      model,
      promptVersion: PROMPT_VERSION,
      persisted: false,
    };
  }

  let persisted = false;
  if (!opts?.dryRun) {
    try {
      persist(productId, output, model);
      persisted = true;
    } catch (e) {
      // Surface but don't lose the output — caller may want to inspect.
      errors.push(`persist failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    productId,
    productName: built.productName,
    output,
    errors,
    warnings,
    model,
    promptVersion: PROMPT_VERSION,
    persisted,
  };
}

/**
 * Read the current persisted listing for a product. Used by the
 * column-mapper at download time and by the validate endpoint to
 * decide whether a product is ready.
 */
export async function getAmazonListing(productId: string) {
  return db
    .select()
    .from(amazonListings)
    .where(eq(amazonListings.productId, productId))
    .get();
}

/** Bulk variant: returns a Map keyed by productId. */
export async function getAmazonListings(productIds: string[]) {
  if (productIds.length === 0) return new Map<string, NonNullable<Awaited<ReturnType<typeof getAmazonListing>>>>();
  const rows = await db
    .select()
    .from(amazonListings)
    .where(inArray(amazonListings.productId, productIds));
  return new Map(rows.map((r) => [r.productId, r]));
}
