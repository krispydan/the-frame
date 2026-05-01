/**
 * Focused Shopify metafield sync — writes ONLY the 3 metafields the user
 * curates via the-frame's tag system:
 *
 *   shopify.lens-polarization
 *   shopify.eyewear-frame-design
 *   shopify.target-gender
 *
 * Does NOT touch SEO, color, age_group, or any other category metafield.
 * Those are managed separately by the AI-driven sync flow in
 * shopify-metafields-sync.
 *
 * Flow per (product × store):
 *   1. Look up the Shopify product ID by SKU prefix
 *   2. Map catalog tags + product columns -> 3 handles
 *   3. Resolve those handles to per-store metaobject GIDs (cached)
 *   4. Submit a single metafieldsSet mutation with up to 3 entries
 *
 * Idempotent. Skips fields that don't resolve (no tag, unknown handle,
 * Shopify GID lookup failed).
 */

import {
  findShopifyProductBySku,
  metafieldsSet,
  resolveMetaobjectHandle,
  type MetafieldsSetInput,
  type ShopifyStore,
} from "@/modules/orders/lib/shopify-api";
import { CATEGORY_METAFIELDS } from "./handles";
import { mapTagsToMetafields, type TagInput } from "./tags-to-metafields";

export interface SyncFromTagsParams {
  store: ShopifyStore;
  /** Jaxy SKU prefix, e.g. "JX1001". */
  skuPrefix: string;
  /** Curated tag rows for this product (catalog_tags WHERE product_id=...) */
  tags: TagInput[];
  /** Legacy product fields (catalog_products columns) — used as fallback. */
  fallbackLensType?: string | null;
  fallbackFrameShape?: string | null;
  fallbackGender?: string | null;
  /** Don't actually post — return the resolved input + dry-run summary. */
  dryRun?: boolean;
}

export interface ResolvedMetafield {
  field: "lens-polarization" | "eyewear-frame-design" | "target-gender";
  /** The mapping guide handle we picked from the-frame data. */
  handle: string;
  /** What it resolved to as a Shopify metaobject GID (null if not found). */
  gid: string | null;
  /** Where in the-frame this came from. */
  source: string | null;
}

export interface SyncFromTagsResult {
  ok: boolean;
  store: ShopifyStore;
  skuPrefix: string;
  shopifyProductId: string | null;
  resolved: ResolvedMetafield[];
  /** Mapping warnings (multi-tag tie-breakers, unmapped values). */
  mappingWarnings: string[];
  /** Number of metafields actually attempted. */
  metafieldsAttempted: number;
  metafieldsWritten: number;
  metafieldErrors: string[];
  /** Inputs we'd send (or did send) to metafieldsSet. */
  metafieldInputs?: MetafieldsSetInput[];
  /** Field-level reasons we skipped writing. */
  skipReasons: Array<{ field: string; reason: string }>;
}

export async function syncMetafieldsFromTags(
  params: SyncFromTagsParams,
): Promise<SyncFromTagsResult> {
  const { store, skuPrefix, tags, dryRun } = params;
  const result: SyncFromTagsResult = {
    ok: false,
    store,
    skuPrefix,
    shopifyProductId: null,
    resolved: [],
    mappingWarnings: [],
    metafieldsAttempted: 0,
    metafieldsWritten: 0,
    metafieldErrors: [],
    skipReasons: [],
  };

  // ── Step 1: locate the Shopify product ──
  const shopifyProduct = await findShopifyProductBySku(store, skuPrefix);
  if (!shopifyProduct) {
    result.metafieldErrors.push(`No Shopify product found with SKU prefix ${skuPrefix} on store ${store}`);
    return result;
  }
  const shopifyProductId = String(shopifyProduct.id);
  const productGid = `gid://shopify/Product/${shopifyProductId}`;
  result.shopifyProductId = shopifyProductId;

  // ── Step 2: map tags to handles ──
  const mapping = mapTagsToMetafields({
    tags,
    fallbackLensType: params.fallbackLensType,
    fallbackFrameShape: params.fallbackFrameShape,
    fallbackGender: params.fallbackGender,
  });
  result.mappingWarnings = mapping.warnings;

  // Plan three metafield slots
  const plan: Array<{
    field: "lens-polarization" | "eyewear-frame-design" | "target-gender";
    fieldKey: "lens_polarization" | "eyewear_frame_design" | "target_gender";
    handle: string | null;
    source: string | null;
  }> = [
    { field: "lens-polarization", fieldKey: "lens_polarization", handle: mapping.lensPolarization, source: mapping.sources.lensPolarization },
    { field: "eyewear-frame-design", fieldKey: "eyewear_frame_design", handle: mapping.eyewearFrameDesign, source: mapping.sources.eyewearFrameDesign },
    { field: "target-gender", fieldKey: "target_gender", handle: mapping.targetGender, source: mapping.sources.targetGender },
  ];

  // ── Step 3: resolve handles to GIDs ──
  const inputs: MetafieldsSetInput[] = [];
  for (const slot of plan) {
    if (!slot.handle) {
      result.skipReasons.push({ field: slot.field, reason: "no value mapped from the-frame data" });
      continue;
    }
    const def = CATEGORY_METAFIELDS[slot.fieldKey];
    let gid: string | null = null;
    try {
      gid = await resolveMetaobjectHandle(store, def.metaobjectType, slot.handle);
    } catch (e) {
      result.metafieldErrors.push(
        `${slot.field}: failed to resolve handle "${slot.handle}" — ${e instanceof Error ? e.message : "unknown"}`,
      );
    }

    result.resolved.push({
      field: slot.field,
      handle: slot.handle,
      gid,
      source: slot.source,
    });

    if (!gid) {
      result.skipReasons.push({
        field: slot.field,
        reason: `Shopify metaobject "${slot.handle}" not found on ${store} (run handle warmer or check spelling)`,
      });
      continue;
    }

    inputs.push({
      ownerId: productGid,
      namespace: def.namespace,
      key: def.key,
      type: def.type,
      // All three target metafields are list.metaobject_reference (single-value
      // but stored as a list per Shopify's standard taxonomy).
      value: JSON.stringify([gid]),
    });
  }

  result.metafieldsAttempted = inputs.length;
  result.metafieldInputs = inputs;

  // ── Step 4: write ──
  if (inputs.length === 0) {
    result.ok = result.skipReasons.length === plan.length && result.metafieldErrors.length === 0;
    return result;
  }
  if (dryRun) {
    result.ok = true;
    return result;
  }

  try {
    const mfRes = await metafieldsSet(store, inputs);
    result.metafieldsWritten = mfRes.written.length;
    result.metafieldErrors.push(...mfRes.userErrors.map((e) => `${(e.field || []).join(".")}: ${e.message}`));
    result.ok = mfRes.userErrors.length === 0;
  } catch (e) {
    result.metafieldErrors.push(e instanceof Error ? e.message : "Unknown error during metafieldsSet");
  }

  return result;
}
