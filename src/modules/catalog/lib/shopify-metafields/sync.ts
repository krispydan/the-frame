/**
 * Sync orchestrator: take an AI categorization output and write it to a
 * Shopify store as taxonomy category + 9 metafields (2 SEO + 7 category).
 *
 * Flow per (product × store):
 *   1. Ensure product category is set to Sunglasses (aa-2-27)
 *   2. Resolve metaobject handles → per-store GIDs (cached)
 *   3. Build a single metafieldsSet input array (all 9 fields)
 *   4. Submit the mutation
 *
 * Idempotent: metafieldsSet is an upsert, productUpdate category is stable.
 * Safe to re-run on every sync.
 */
import {
  metafieldsSet,
  resolveMetaobjectHandle,
  setProductCategory,
  type MetafieldsSetInput,
  type ShopifyStore,
} from "@/modules/orders/lib/shopify-api";
import {
  CATEGORY_METAFIELDS,
  SUNGLASSES_CATEGORY_GID,
  type AiCategorizationOutput,
} from "./handles";
import {
  buildExtendedMetafields,
  type ProductForExtendedMetafields,
} from "./extended-metafields";

// ── Handle → GID cache (per store + type, in-process) ──

interface HandleCacheKey {
  store: ShopifyStore;
  type: string;
  handle: string;
}

const handleCache = new Map<string, string | null>();

function cacheKey({ store, type, handle }: HandleCacheKey): string {
  return `${store}::${type}::${handle}`;
}

async function resolveHandleCached(
  store: ShopifyStore,
  type: string,
  handle: string,
): Promise<string | null> {
  const k = cacheKey({ store, type, handle });
  if (handleCache.has(k)) return handleCache.get(k) ?? null;
  const gid = await resolveMetaobjectHandle(store, type, handle);
  handleCache.set(k, gid);
  return gid;
}

/** Manually clear the cache — exposed for tests / admin tooling. */
export function clearHandleCache(): void {
  handleCache.clear();
}

// ── Types ──

export interface SyncProductMetafieldsParams {
  store: ShopifyStore;
  /** Numeric Shopify product ID (not a GID — we'll construct the GID here). */
  shopifyProductId: string;
  categorization: AiCategorizationOutput;
  /** Optional extended metafields snapshot — when provided, the sync
   *  ALSO writes the deterministic SEO + custom labels + style_era +
   *  collection_batch metafields, OVERRIDING the AI-categorization
   *  seo.title/seo.description with the deterministic builders'
   *  output (no override mechanism in v1 per Daniel's call).
   *  When omitted, the sync behaves exactly as before (legacy
   *  callers stay green). */
  extended?: ProductForExtendedMetafields;
  /** If true, skip the category-set step (assume already set). Default false. */
  skipCategory?: boolean;
  /** If true, don't actually write — return what would be written. */
  dryRun?: boolean;
}

export interface SyncProductMetafieldsResult {
  ok: boolean;
  productGid: string;
  categorySet: boolean;
  categoryError?: string;
  resolvedHandles: Array<{ field: string; handle: string; gid: string | null }>;
  metafieldsWritten: number;
  metafieldsAttempted: number;
  metafieldInputs?: MetafieldsSetInput[]; // populated when dryRun=true
  metafieldErrors: Array<{ field: string[] | null; message: string; code: string | null }>;
  problems: string[]; // non-fatal issues (dropped fields, unresolved handles)
}

// ── Main sync function ──

export async function syncProductMetafields(
  params: SyncProductMetafieldsParams,
): Promise<SyncProductMetafieldsResult> {
  const { store, shopifyProductId, categorization, extended, skipCategory, dryRun } = params;
  const productGid = shopifyProductId.startsWith("gid://")
    ? shopifyProductId
    : `gid://shopify/Product/${shopifyProductId}`;

  const result: SyncProductMetafieldsResult = {
    ok: false,
    productGid,
    categorySet: false,
    resolvedHandles: [],
    metafieldsWritten: 0,
    metafieldsAttempted: 0,
    metafieldErrors: [],
    problems: [],
  };

  // ── Step 1: Set category ──
  if (!skipCategory && !dryRun) {
    try {
      const catRes = await setProductCategory(store, productGid, SUNGLASSES_CATEGORY_GID);
      if (!catRes.ok) {
        result.categoryError = catRes.userErrors.map((e) => e.message).join("; ");
        result.problems.push(`category: ${result.categoryError}`);
      } else {
        result.categorySet = true;
      }
    } catch (e) {
      result.categoryError = String(e);
      result.problems.push(`category: ${String(e)}`);
    }
  } else {
    result.categorySet = skipCategory || false;
  }

  // ── Step 2: Resolve handles → GIDs ──
  //
  // The three color fields (color_pattern, eyewear_frame_color, lens_color)
  // all resolve against the same shopify--color-pattern metaobject type, so
  // the cache naturally dedupes.

  const cm = categorization.category_metafields;

  const colorPatternGids = await resolveHandleList(
    store,
    CATEGORY_METAFIELDS.color_pattern.metaobjectType,
    cm.color_pattern,
    "color_pattern",
    result,
  );
  const frameColorGids = await resolveHandleList(
    store,
    CATEGORY_METAFIELDS.eyewear_frame_color.metaobjectType,
    cm.eyewear_frame_color,
    "eyewear_frame_color",
    result,
  );
  const lensColorGids = await resolveHandleList(
    store,
    CATEGORY_METAFIELDS.lens_color.metaobjectType,
    cm.lens_color,
    "lens_color",
    result,
  );
  const ageGroupGid = await resolveSingle(
    store,
    CATEGORY_METAFIELDS.age_group.metaobjectType,
    cm.age_group,
    "age_group",
    result,
  );
  const polarizationGid = await resolveSingle(
    store,
    CATEGORY_METAFIELDS.lens_polarization.metaobjectType,
    cm.lens_polarization,
    "lens_polarization",
    result,
  );
  const genderGid = await resolveSingle(
    store,
    CATEGORY_METAFIELDS.target_gender.metaobjectType,
    cm.target_gender,
    "target_gender",
    result,
  );
  const frameDesignGid = await resolveSingle(
    store,
    CATEGORY_METAFIELDS.eyewear_frame_design.metaobjectType,
    cm.eyewear_frame_design,
    "eyewear_frame_design",
    result,
  );

  // ── Step 3: Build metafieldsSet input ──

  const metafields: MetafieldsSetInput[] = [];

  // SEO (global namespace, plain strings — not category-driven).
  // When the caller provides an `extended` snapshot we DROP the AI-
  // generated seo.title/seo.description because the deterministic
  // builders (Phase 2) produce them downstream — no v1 override
  // mechanism, the formula always wins.
  if (!extended) {
    if (categorization.seo.title) {
      metafields.push({
        ownerId: productGid,
        namespace: "global",
        key: "title_tag",
        type: "single_line_text_field",
        value: categorization.seo.title,
      });
    }
    if (categorization.seo.description) {
      metafields.push({
        ownerId: productGid,
        namespace: "global",
        key: "description_tag",
        type: "multi_line_text_field",
        value: categorization.seo.description,
      });
    }
  }

  // Category metafields (list.metaobject_reference, value is JSON-encoded string of GID array)
  const addListMetafield = (fieldKey: keyof typeof CATEGORY_METAFIELDS, gids: string[]) => {
    if (gids.length === 0) return;
    const def = CATEGORY_METAFIELDS[fieldKey];
    metafields.push({
      ownerId: productGid,
      namespace: def.namespace,
      key: def.key,
      type: def.type,
      value: JSON.stringify(gids),
    });
  };

  addListMetafield("color_pattern", colorPatternGids);
  addListMetafield("eyewear_frame_color", frameColorGids);
  addListMetafield("lens_color", lensColorGids);
  if (ageGroupGid) addListMetafield("age_group", [ageGroupGid]);
  if (polarizationGid) addListMetafield("lens_polarization", [polarizationGid]);
  if (genderGid) addListMetafield("target_gender", [genderGid]);
  if (frameDesignGid) addListMetafield("eyewear_frame_design", [frameDesignGid]);

  // ── Extended metafields (Phase 4 of the SEO sync brief) ──
  // Deterministic SEO title / description, Custom Labels 0-4,
  // style_era, collection_batch. Pure builder — no IO. Same
  // metafieldsSet mutation, just more entries in the input array.
  if (extended) {
    metafields.push(...buildExtendedMetafields(productGid, extended));
  }

  result.metafieldsAttempted = metafields.length;

  // ── Step 4: Write metafields ──

  if (dryRun) {
    result.metafieldInputs = metafields;
    result.ok = result.problems.length === 0;
    return result;
  }

  try {
    const writeRes = await metafieldsSet(store, metafields);
    result.metafieldsWritten = writeRes.written.length;
    result.metafieldErrors = writeRes.userErrors;
    result.ok = writeRes.ok && !result.categoryError;
  } catch (e) {
    result.problems.push(`metafieldsSet: ${String(e)}`);
    result.ok = false;
  }

  return result;
}

// ── Resolution helpers ──

async function resolveHandleList(
  store: ShopifyStore,
  type: string,
  handles: string[],
  fieldName: string,
  result: SyncProductMetafieldsResult,
): Promise<string[]> {
  const gids: string[] = [];
  for (const h of handles) {
    const gid = await resolveHandleCached(store, type, h);
    result.resolvedHandles.push({ field: fieldName, handle: h, gid });
    if (gid) {
      gids.push(gid);
    } else {
      result.problems.push(`${fieldName}: handle "${h}" did not resolve on ${store}`);
    }
  }
  return gids;
}

async function resolveSingle(
  store: ShopifyStore,
  type: string,
  handle: string,
  fieldName: string,
  result: SyncProductMetafieldsResult,
): Promise<string | null> {
  const gid = await resolveHandleCached(store, type, handle);
  result.resolvedHandles.push({ field: fieldName, handle, gid });
  if (!gid) {
    result.problems.push(`${fieldName}: handle "${handle}" did not resolve on ${store}`);
  }
  return gid;
}
