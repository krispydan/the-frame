export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import {
  getProductMetafields,
  hasShopifyCredentials,
  type ShopifyStore,
} from "@/modules/orders/lib/shopify-api";

/**
 * GET /api/v1/catalog/shopify-metafields?store=wholesale&productId=9127374979221
 * Read all metafields for a Shopify product. Used to introspect the structure
 * of badge / custom metafields before writing a sync.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const store = (searchParams.get("store") || "wholesale") as ShopifyStore;
  const productId = searchParams.get("productId");

  if (!productId) {
    return NextResponse.json({ error: "productId required" }, { status: 400 });
  }
  if (store !== "dtc" && store !== "wholesale") {
    return NextResponse.json({ error: "store must be 'dtc' or 'wholesale'" }, { status: 400 });
  }
  if (!hasShopifyCredentials(store)) {
    return NextResponse.json(
      { error: `Shopify ${store} credentials not configured` },
      { status: 400 },
    );
  }

  try {
    const metafields = await getProductMetafields(store, productId);
    return NextResponse.json({ store, productId, count: metafields.length, metafields });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
