/**
 * Focused Shopify metafield sync — writes ONLY the 4 metafields the user
 * curates via the-frame's tag/SKU data:
 *
 *   shopify.lens-polarization     (single)  ← lens tag / products.lens_type
 *   shopify.eyewear-frame-design  (single)  ← frameShape tag / products.frame_shape
 *   shopify.target-gender         (single)  ← gender tag / products.gender
 *   shopify.color-pattern         (list)    ← unique colors across SKUs (color_name)
 *
 * Does NOT touch SEO, age_group, lens-color, eyewear-frame-color, or any
 * other category metafield. Those are managed separately by the AI-driven
 * sync flow in shopify-metafields-sync.
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
import { CATEGORY_METAFIELDS, type ColorPatternHandle } from "./handles";
import { inferColorHandles } from "./color-mapping";
import { mapTagsToMetafields, type TagInput } from "./tags-to-metafields";

/**
 * Per-handle fallback list. If the canonical handle doesn't exist on a
 * store, try these equivalents in order. Used to absorb naming drift
 * between retail and wholesale (different shop owners seeded handles
 * differently for the same semantic value).
 */
const HANDLE_FALLBACKS: Record<string, string[]> = {
  // Retail seeded a custom entry "uv400"; wholesale renamed the standard
  // "non-polarized" display to "UV400" but kept its handle.
  uv400: ["non-polarized"],
  "non-polarized": ["uv400"],
};

export interface SyncFromTagsParams {
  store: ShopifyStore;
  /** Jaxy SKU prefix, e.g. "JX1001". */
  skuPrefix: string;
  /** Curated tag rows for this product (catalog_tags WHERE product_id=...) */
  tags: TagInput[];
  /** SKU color_name values for this product — used to derive color-pattern. */
  skuColorNames?: Array<string | null | undefined>;
  /** Don't actually post — return the resolved input + dry-run summary. */
  dryRun?: boolean;
}

export interface ResolvedMetafield {
  field:
    | "lens-polarization"
    | "eyewear-frame-design"
    | "target-gender"
    | "color-pattern"
    | "custom.frame_shape"
    | "custom.lens_type";
  /** The mapping guide handle(s) we picked from the-frame data. */
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
  const { store, skuPrefix, tags, skuColorNames, dryRun } = params;
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

  // ── Step 2b: derive color-pattern handles from SKU color names ──
  const colorHandles: ColorPatternHandle[] = [];
  const colorSourceParts: string[] = [];
  if (skuColorNames && skuColorNames.length > 0) {
    const seen = new Set<ColorPatternHandle>();
    for (const name of skuColorNames) {
      if (!name) continue;
      const handles = inferColorHandles(name);
      if (handles.length === 0) {
        result.mappingWarnings.push(`color-pattern: SKU color "${name}" didn't map to any Shopify color handle`);
        continue;
      }
      for (const h of handles) {
        if (!seen.has(h)) {
          seen.add(h);
          colorHandles.push(h);
        }
      }
      colorSourceParts.push(name);
    }
  }

  // ── Step 3: resolve handles to GIDs ──
  const inputs: MetafieldsSetInput[] = [];
  for (const slot of plan) {
    if (!slot.handle) {
      result.skipReasons.push({ field: slot.field, reason: "no value mapped from the-frame data" });
      continue;
    }
    const def = CATEGORY_METAFIELDS[slot.fieldKey];

    // Some handles diverge per store (e.g. retail uses "uv400" as a custom
    // entry; wholesale uses standard "non-polarized" with display renamed).
    // Try the canonical handle first, then any known equivalents.
    const tryHandles: string[] = [slot.handle, ...(HANDLE_FALLBACKS[slot.handle] ?? [])];

    let gid: string | null = null;
    let resolvedHandle = slot.handle;
    for (const h of tryHandles) {
      try {
        gid = await resolveMetaobjectHandle(store, def.metaobjectType, h);
      } catch (e) {
        result.metafieldErrors.push(
          `${slot.field}: failed to resolve handle "${h}" — ${e instanceof Error ? e.message : "unknown"}`,
        );
      }
      if (gid) {
        resolvedHandle = h;
        break;
      }
    }

    result.resolved.push({
      field: slot.field,
      handle: resolvedHandle,
      gid,
      source: slot.source,
    });

    if (!gid) {
      result.skipReasons.push({
        field: slot.field,
        reason: `Shopify metaobject not found on ${store} (tried: ${tryHandles.join(", ")})`,
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

  // ── Color-pattern (multi-value list) ──
  if (colorHandles.length === 0) {
    result.skipReasons.push({ field: "color-pattern", reason: "no SKU colors mapped to Shopify handles" });
  } else {
    const def = CATEGORY_METAFIELDS.color_pattern;
    const colorGids: string[] = [];
    for (const h of colorHandles) {
      let gid: string | null = null;
      try {
        gid = await resolveMetaobjectHandle(store, def.metaobjectType, h);
      } catch (e) {
        result.metafieldErrors.push(
          `color-pattern: failed to resolve handle "${h}" — ${e instanceof Error ? e.message : "unknown"}`,
        );
      }
      result.resolved.push({
        field: "color-pattern",
        handle: h,
        gid,
        source: colorSourceParts.join(" / ") || null,
      });
      if (gid) {
        colorGids.push(gid);
      } else {
        result.skipReasons.push({
          field: "color-pattern",
          reason: `Shopify metaobject "${h}" not found on ${store}`,
        });
      }
    }
    if (colorGids.length > 0) {
      inputs.push({
        ownerId: productGid,
        namespace: def.namespace,
        key: def.key,
        type: def.type,
        value: JSON.stringify(colorGids),
      });
    }
  }

  // ── custom.lens_type (single_line_text_field) ──
  // Plain-text mirror of shopify.lens-polarization for theme convenience.
  if (mapping.customLensType) {
    inputs.push({
      ownerId: productGid,
      namespace: "custom",
      key: "lens_type",
      type: "single_line_text_field",
      value: mapping.customLensType,
    });
    result.resolved.push({
      field: "custom.lens_type",
      handle: mapping.customLensType,
      gid: null,
      source: mapping.sources.customLensType,
    });
  } else {
    result.skipReasons.push({ field: "custom.lens_type", reason: "no value mapped from the-frame data" });
  }

  // ── custom.frame_shape (list.single_line_text_field, full vocab) ──
  // Plain-text metafield — no GID resolution needed. Writes the rich label
  // ("Oversized", "Square", etc.) so the storefront keeps the full vocab even
  // though shopify.eyewear-frame-design is constrained to 6 enum values.
  if (mapping.customFrameShape) {
    inputs.push({
      ownerId: productGid,
      namespace: "custom",
      key: "frame_shape",
      type: "list.single_line_text_field",
      value: JSON.stringify([mapping.customFrameShape]),
    });
    result.resolved.push({
      field: "custom.frame_shape",
      handle: mapping.customFrameShape,
      gid: null, // not a reference — plain text
      source: mapping.sources.customFrameShape,
    });
  } else {
    result.skipReasons.push({ field: "custom.frame_shape", reason: "no value mapped from the-frame data" });
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
