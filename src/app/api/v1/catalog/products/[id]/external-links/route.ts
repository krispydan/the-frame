export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { products } from "@/modules/catalog/schema";
import { shopifyShops } from "@/modules/integrations/schema/shopify";
import { eq } from "drizzle-orm";
import {
  findShopifyProductBySku,
  hasShopifyCredentials,
  type ShopifyStore,
} from "@/modules/orders/lib/shopify-api";

/**
 * GET /api/v1/catalog/products/{id}/external-links
 *
 * Resolves the URL of this product on every external sales channel that
 * has a known integration. Used by the Catalog product detail page to
 * render quick-jump buttons (open in Shopify retail/wholesale admin,
 * Faire seller portal, Amazon Seller Central, TikTok Shop, etc.).
 *
 * Faire/Amazon/TikTok integrations don't exist yet — those entries are
 * returned as { channel, label, available: false } so the UI can render
 * disabled buttons.
 */

interface ExternalLink {
  channel: "shopify_retail" | "shopify_wholesale" | "faire" | "amazon" | "tiktok_shop";
  label: string;
  available: boolean;
  url: string | null;
  /** Why a link couldn't be built (debug breadcrumb shown on hover). */
  reason?: string;
}

/** Convert a *.myshopify.com domain to its admin URL slug. */
function shopAdminSlug(shopDomain: string): string {
  // "getjaxy.myshopify.com" → "getjaxy"
  // "jaxy-wholesale.myshopify.com" → "jaxy-wholesale"
  return shopDomain.replace(/\.myshopify\.com$/i, "");
}

async function resolveShopifyLink(
  channel: "shopify_retail" | "shopify_wholesale",
  shopifyStoreType: ShopifyStore,
  shopChannel: "retail" | "wholesale",
  skuPrefix: string,
  label: string,
): Promise<ExternalLink> {
  const ok = await hasShopifyCredentials(shopifyStoreType);
  if (!ok) {
    return { channel, label, available: false, url: null, reason: "Shopify not connected" };
  }

  // Look up the admin slug from the installed shop row.
  const shop = (
    await db.select().from(shopifyShops).where(eq(shopifyShops.channel, shopChannel)).limit(1)
  )[0];
  if (!shop) {
    return { channel, label, available: false, url: null, reason: "shop row missing" };
  }
  const slug = shopAdminSlug(shop.shopDomain);

  // Resolve the Shopify product ID by SKU prefix. If the product hasn't
  // been pushed to that store yet, fall back to a search URL.
  try {
    const sp = await findShopifyProductBySku(shopifyStoreType, skuPrefix);
    if (sp) {
      return {
        channel,
        label,
        available: true,
        url: `https://admin.shopify.com/store/${slug}/products/${sp.id}`,
      };
    }
    return {
      channel,
      label,
      available: true,
      url: `https://admin.shopify.com/store/${slug}/products?query=${encodeURIComponent(skuPrefix)}`,
      reason: `not yet on ${shopChannel} — opens search`,
    };
  } catch (e) {
    return {
      channel,
      label,
      available: false,
      url: null,
      reason: `lookup failed: ${e instanceof Error ? e.message : "unknown"}`,
    };
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Accept UUID or skuPrefix so the page can call this with whichever it has.
  let product = (await db.select().from(products).where(eq(products.id, id)))[0];
  if (!product) {
    product = (await db.select().from(products).where(eq(products.skuPrefix, id)))[0];
  }
  if (!product || !product.skuPrefix) {
    return NextResponse.json({ error: `Product not found: ${id}` }, { status: 404 });
  }
  const skuPrefix = product.skuPrefix;

  const [retail, wholesale] = await Promise.all([
    resolveShopifyLink("shopify_retail", "dtc", "retail", skuPrefix, "Shopify Retail"),
    resolveShopifyLink("shopify_wholesale", "wholesale", "wholesale", skuPrefix, "Shopify Wholesale"),
  ]);

  // Future channels — return placeholder rows so the UI knows what to render
  // disabled and we don't silently forget them.
  const future: ExternalLink[] = [
    { channel: "faire", label: "Faire", available: false, url: null, reason: "integration not yet wired" },
    { channel: "amazon", label: "Amazon Seller Central", available: false, url: null, reason: "integration not yet wired" },
    { channel: "tiktok_shop", label: "TikTok Shop", available: false, url: null, reason: "integration not yet wired" },
  ];

  return NextResponse.json({
    productId: product.id,
    skuPrefix,
    links: [retail, wholesale, ...future],
  });
}
