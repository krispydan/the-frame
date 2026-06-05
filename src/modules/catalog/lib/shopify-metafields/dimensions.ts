/**
 * Push frame-dimension custom metafields to Shopify.
 *
 * Kept separate from sync.ts (which is purely about category-driven
 * metaobject-reference metafields derived from AI categorization) — these
 * are plain `number_integer` values keyed on the catalog row.
 *
 * Namespace + key follow the existing `custom.<field>` convention so the
 * storefront/themes can render them with a one-liner via Liquid:
 *
 *   {{ product.metafields.custom.lens_width }} mm
 */

import {
  metafieldsSet,
  type MetafieldsSetInput,
  type ShopifyStore,
} from "@/modules/orders/lib/shopify-api";

export interface SyncDimensionsParams {
  store: ShopifyStore;
  shopifyProductId: string | number;
  lensWidth: number | null;
  bridgeWidth: number | null;
  templeLength: number | null;
  lensHeight: number | null;
  /** Total frame width edge-to-edge (mm), when supplied. */
  frameWidth: number | null;
  /** Total frame height edge-to-edge (mm). 6th dimension — needed for
   *  the Google Shopping product_detail[frame_height] feed attribute
   *  (added in Phase 1 of the SEO sync brief). */
  frameHeight: number | null;
}

export interface SyncDimensionsResult {
  ok: boolean;
  written: number;
  attempted: number;
  errors: string[];
}

const NAMESPACE = "custom";

export async function syncProductDimensions(
  params: SyncDimensionsParams,
): Promise<SyncDimensionsResult> {
  const { store, shopifyProductId } = params;
  const productGid = String(shopifyProductId).startsWith("gid://")
    ? String(shopifyProductId)
    : `gid://shopify/Product/${shopifyProductId}`;

  const fields: Array<[string, number | null]> = [
    ["lens_width", params.lensWidth],
    ["bridge_width", params.bridgeWidth],
    ["temple_length", params.templeLength],
    ["lens_height", params.lensHeight],
    ["frame_width", params.frameWidth],
    ["frame_height", params.frameHeight],
  ];

  const inputs: MetafieldsSetInput[] = fields
    .filter(([, value]) => value != null && value > 0)
    .map(([key, value]) => ({
      ownerId: productGid,
      namespace: NAMESPACE,
      key,
      type: "number_integer",
      value: String(value),
    }));

  if (inputs.length === 0) {
    return { ok: true, written: 0, attempted: 0, errors: [] };
  }

  try {
    const res = await metafieldsSet(store, inputs);
    return {
      ok: res.ok,
      written: res.written.length,
      attempted: inputs.length,
      errors: res.userErrors.map((e) => e.message),
    };
  } catch (e) {
    return {
      ok: false,
      written: 0,
      attempted: inputs.length,
      errors: [e instanceof Error ? e.message : String(e)],
    };
  }
}
