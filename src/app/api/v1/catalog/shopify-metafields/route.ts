export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import {
  getProductMetafields,
  getMetafieldDefinition,
  hasShopifyCredentials,
  type ShopifyStore,
} from "@/modules/orders/lib/shopify-api";

/**
 * GET /api/v1/catalog/shopify-metafields
 *   ?store=wholesale|dtc
 *   &productId=9127374979221    (read all metafields on a product)
 *   &definitionId=209649270933  (read a metafield definition by ID)
 *
 * Used to introspect badge / custom metafields before writing a sync.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const store = (searchParams.get("store") || "wholesale") as ShopifyStore;
  const productId = searchParams.get("productId");
  const definitionId = searchParams.get("definitionId");

  if (store !== "dtc" && store !== "wholesale") {
    return NextResponse.json({ error: "store must be 'dtc' or 'wholesale'" }, { status: 400 });
  }
  if (!(await hasShopifyCredentials(store))) {
    return NextResponse.json(
      { error: `Shopify ${store} credentials not configured` },
      { status: 400 },
    );
  }
  if (!productId && !definitionId) {
    return NextResponse.json(
      { error: "productId or definitionId required" },
      { status: 400 },
    );
  }

  try {
    const result: Record<string, unknown> = { store };
    if (definitionId) {
      result.definitionId = definitionId;
      result.definition = await getMetafieldDefinition(store, definitionId);
    }
    if (productId) {
      const metafields = await getProductMetafields(store, productId);
      result.productId = productId;
      result.count = metafields.length;
      result.metafields = metafields;
    }
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
