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
import { assembleProductKeywords } from "@/modules/catalog/lib/keywords/assemble";
import {
  buildAmazonListingPrompt,
  validateAmazonListingOutput,
  PROMPT_VERSION,
  type AmazonListingInput,
  type AmazonListingOutput,
  buildAmazonGroupListingPrompt,
  validateAmazonGroupListingOutput,
  type AmazonGroupListingInput,
  type AmazonGroupListingOutput,
  type AmazonGroupStyleSummary,
} from "./amazon-listing-prompt";
import { getShopifyImageUrls } from "./shopify-image-urls";
import { amazonListingGroups } from "@/modules/catalog/schema";

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

  // Secondary shapes (catalog_tags dimension='secondary_shape') let a
  // style that legitimately reads as two shapes pull keywords from both
  // pools, so it ranks for each. Primary shape is the curated frameShape.
  const secondaryShapes = allTags
    .filter((t) => (t.dimension ?? "").toLowerCase() === "secondary_shape")
    .map((t) => (t.tagName ?? "").trim())
    .filter(Boolean);

  // Ranked, brand-scrubbed keyword pools from the assembler — replaces
  // the old raw dimension='keyword' tag dump.
  const keywordSet = assembleProductKeywords({
    primaryShape: curated.frameShape,
    secondaryShapes,
  });

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
      keywordSet,
      availableColors,
      imageUrls,
      existingDescription: product.description,
      // Frame dimensions captured by the catalog edit UI / MCP; passed
      // straight through to the prompt + downstream cells via the
      // column-mapper.
      lensWidth: product.lensWidth ?? null,
      bridgeWidth: product.bridgeWidth ?? null,
      templeLength: product.templeLength ?? null,
      lensHeight: product.lensHeight ?? null,
      frameWidth: product.frameWidth ?? null,
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
  opts?: {
    dryRun?: boolean;
    modelOverride?: string;
    /** Validation issues from a prior run; when provided, the prompt
     *  builder prepends a "FIX THESE" section so the model treats them
     *  as hard constraints. Used by the dialog's AI auto-fix flow. */
    repairIssues?: string[];
  },
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

  const { system, messages } = buildAmazonListingPrompt(built.input, {
    repairIssues: opts?.repairIssues,
  });

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

  // Ship the assembler's backend verbatim into generic_keywords — it's
  // volume-ranked, brand-scrubbed, token-deduped against the title/
  // bullets and byte-safe, so it beats whatever the model returns.
  // Guard against an empty pool (e.g. a shapeless product).
  const backend = built.input.keywordSet.backend;
  if (backend) {
    output.generic_keywords = backend;
    output.char_count.generic_keywords = Buffer.byteLength(backend, "utf8");
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

// ─────────────────────────────────────────────────────────────────────
// Group-level orchestrator (Phase 3 of the Amazon group restructure)
// ─────────────────────────────────────────────────────────────────────

export interface GenerateAmazonGroupResult {
  groupKey: string;
  shape: string;
  styleCount: number;
  output: AmazonGroupListingOutput | null;
  errors: string[];
  warnings: string[];
  model: string;
  promptVersion: string;
  persisted: boolean;
}

/**
 * Compute the parent's polarization claim from the actual mix of
 * styles in the group. Amazon's variation_theme is color/lenscolor so
 * polarization is an inherited field — the parent picks one claim and
 * children CAN override per row.
 *
 * Heuristic: if every style is polarized → "Polarized". If every style
 * is UV400 only → "UV400 Protection". If mixed → "Polarized & UV400"
 * (covers both honestly without forcing one).
 */
function computePolarizationClaim(lensTypes: ReadonlyArray<string | null>): string {
  const norm = lensTypes
    .map((l) => (l ?? "").toLowerCase().trim())
    .filter(Boolean);
  if (norm.length === 0) return "Polarized & UV400"; // safe default
  const anyPolarized = norm.some((l) => l.includes("polarized"));
  const anyUv = norm.some((l) => l.includes("uv"));
  if (anyPolarized && anyUv) return "Polarized & UV400";
  if (anyPolarized) return "Polarized";
  if (anyUv) return "UV400 Protection";
  return "Polarized & UV400";
}

/** Resolve a canonical display name for a group key. */
function shapeDisplayName(groupKey: string): string {
  const map: Record<string, string> = {
    round: "Round",
    square: "Square",
    rectangle: "Rectangle",
    oval: "Oval",
    "cat-eye": "Cat Eye",
    aviator: "Aviator",
    hexagonal: "Hexagonal",
    oversized: "Oversized",
    geometric: "Geometric",
  };
  return map[groupKey] ?? (groupKey[0]?.toUpperCase() + groupKey.slice(1));
}

interface GroupBuildResult {
  input: AmazonGroupListingInput;
  shape: string;
  styleCount: number;
  representativeProductId: string;
  productIdsInGroup: string[];
}

/**
 * Load every product in a group, gather hero images + curated attrs,
 * shape into the Anthropic prompt input. Returns null if the group is
 * empty (no products carry the key — caller short-circuits).
 *
 * The "first product" rule (per Daniel's call for the parent image)
 * is implemented by ordering on sku_prefix ASC — deterministic across
 * runs.
 */
async function buildGroupInput(groupKey: string): Promise<GroupBuildResult | null> {
  const rows = await db
    .select()
    .from(products)
    .where(eq(products.amazonGroupKey, groupKey));
  if (rows.length === 0) return null;

  // Stable ordering — first by sku_prefix gives the same "first
  // product" every run regardless of insert order.
  const sorted = [...rows].sort((a, b) =>
    (a.skuPrefix ?? "").localeCompare(b.skuPrefix ?? ""),
  );

  const styles: AmazonGroupStyleSummary[] = [];
  const lensTypes: Array<string | null> = [];
  let dominantFrameMaterial: string | null = null;

  for (const product of sorted) {
    const allSkus = await db.select().from(skus).where(eq(skus.productId, product.id));
    const allTags = await db.select().from(tags).where(eq(tags.productId, product.id));
    const curated = curatedAttrsFromTags(
      allTags.map((t) => ({ tagName: t.tagName, dimension: t.dimension })),
    );
    const colors = Array.from(
      new Set(allSkus.map((s) => (s.colorName ?? "").trim()).filter(Boolean)),
    );
    const heroes = product.skuPrefix
      ? await getShopifyImageUrls(product.skuPrefix)
      : [];

    styles.push({
      productName: product.name ?? product.skuPrefix ?? "(unnamed)",
      skuPrefix: product.skuPrefix ?? "",
      heroImageUrl: heroes[0] ?? null,
      colors,
      lensType: curated.lensType,
    });
    lensTypes.push(curated.lensType);
    if (!dominantFrameMaterial && curated.frameMaterial) {
      dominantFrameMaterial = curated.frameMaterial;
    }
  }

  return {
    input: {
      groupKey,
      shapeDisplay: shapeDisplayName(groupKey),
      styles,
      dominantFrameMaterial,
      polarizationClaim: computePolarizationClaim(lensTypes),
      // Pool keywords across the group — dedup + cap so prompt
      // stays compact.
      keywords: Array.from(new Set(
        sorted.flatMap((p) => p.skuPrefix ? [p.skuPrefix] : []),
      )),
    },
    shape: groupKey,
    styleCount: rows.length,
    representativeProductId: sorted[0].id,
    productIdsInGroup: sorted.map((p) => p.id),
  };
}

function persistGroup(
  groupKey: string,
  shape: string,
  output: AmazonGroupListingOutput,
  representativeProductId: string,
  model: string,
): void {
  const displayName = shapeDisplayName(groupKey) + " Sunglasses";
  sqlite
    .prepare(
      `INSERT INTO catalog_amazon_listing_groups (
        id, group_key, shape, display_name, title, product_description,
        bullet_point_1, bullet_point_2, bullet_point_3, bullet_point_4, bullet_point_5,
        generic_keywords, representative_product_id,
        model_used, prompt_version, generated_at,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now')
      )
      ON CONFLICT(group_key) DO UPDATE SET
        shape = excluded.shape,
        display_name = excluded.display_name,
        title = excluded.title,
        product_description = excluded.product_description,
        bullet_point_1 = excluded.bullet_point_1,
        bullet_point_2 = excluded.bullet_point_2,
        bullet_point_3 = excluded.bullet_point_3,
        bullet_point_4 = excluded.bullet_point_4,
        bullet_point_5 = excluded.bullet_point_5,
        generic_keywords = excluded.generic_keywords,
        representative_product_id = excluded.representative_product_id,
        model_used = excluded.model_used,
        prompt_version = excluded.prompt_version,
        generated_at = excluded.generated_at,
        updated_at = datetime('now')`,
    )
    .run(
      crypto.randomUUID(),
      groupKey,
      shape,
      displayName,
      output.title,
      output.description,
      output.bullet_points[0], output.bullet_points[1], output.bullet_points[2],
      output.bullet_points[3], output.bullet_points[4],
      output.generic_keywords,
      representativeProductId,
      model,
      PROMPT_VERSION,
      new Date().toISOString(),
    );
}

/**
 * Generate Amazon listing copy for one shape group. Soft-failure shape
 * to mirror the per-product orchestrator — the batch caller wants to
 * keep going on individual group errors.
 */
export async function generateAmazonGroupListing(
  groupKey: string,
  opts?: { dryRun?: boolean; modelOverride?: string; repairIssues?: string[] },
): Promise<GenerateAmazonGroupResult> {
  const model = opts?.modelOverride || process.env.AMAZON_AI_MODEL || DEFAULT_MODEL;
  const built = await buildGroupInput(groupKey);
  if (!built) {
    return {
      groupKey, shape: groupKey, styleCount: 0, output: null,
      errors: [`group "${groupKey}" has no products with that amazon_group_key`],
      warnings: [], model, promptVersion: PROMPT_VERSION, persisted: false,
    };
  }

  const stylesWithImages = built.input.styles.filter((s) => s.heroImageUrl);
  if (stylesWithImages.length === 0) {
    return {
      groupKey, shape: built.shape, styleCount: built.styleCount, output: null,
      errors: ["no styles in this group have Shopify CDN hero images — vision needs photos"],
      warnings: [], model, promptVersion: PROMPT_VERSION, persisted: false,
    };
  }

  const { system, messages } = buildAmazonGroupListingPrompt(built.input, {
    repairIssues: opts?.repairIssues,
  });

  let rawText = "";
  try {
    rawText = await callClaudeVision(system, messages, model);
  } catch (e) {
    return {
      groupKey, shape: built.shape, styleCount: built.styleCount, output: null,
      errors: [`Claude call failed: ${e instanceof Error ? e.message : String(e)}`],
      warnings: [], model, promptVersion: PROMPT_VERSION, persisted: false,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapJson(rawText));
  } catch (e) {
    return {
      groupKey, shape: built.shape, styleCount: built.styleCount, output: null,
      errors: [`output is not valid JSON: ${e instanceof Error ? e.message : "parse error"}`],
      warnings: [], model, promptVersion: PROMPT_VERSION, persisted: false,
    };
  }

  const { output, errors, warnings } = validateAmazonGroupListingOutput(parsed);
  if (!output) {
    return {
      groupKey, shape: built.shape, styleCount: built.styleCount, output: null,
      errors, warnings, model, promptVersion: PROMPT_VERSION, persisted: false,
    };
  }

  let persisted = false;
  if (!opts?.dryRun) {
    try {
      persistGroup(groupKey, built.shape, output, built.representativeProductId, model);
      persisted = true;
    } catch (e) {
      errors.push(`persist failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    groupKey, shape: built.shape, styleCount: built.styleCount,
    output, errors, warnings, model, promptVersion: PROMPT_VERSION, persisted,
  };
}

/**
 * List every distinct amazon_group_key with at least one product, so
 * the batch endpoint can iterate without hardcoding the set.
 */
export async function listAmazonGroupKeys(): Promise<Array<{ groupKey: string; count: number }>> {
  const rows = sqlite.prepare(
    `SELECT amazon_group_key as groupKey, COUNT(*) as n
       FROM catalog_products
      WHERE amazon_group_key IS NOT NULL
      GROUP BY amazon_group_key
      ORDER BY n DESC`,
  ).all() as Array<{ groupKey: string; n: number }>;
  return rows.map((r) => ({ groupKey: r.groupKey, count: r.n }));
}

/** Read the persisted group listing for a key. Used by Phase 4
 *  row-composer to source title/bullets/description for the parent
 *  row in the TSV output. */
export async function getAmazonGroupListing(groupKey: string) {
  return db
    .select()
    .from(amazonListingGroups)
    .where(eq(amazonListingGroups.groupKey, groupKey))
    .get();
}
