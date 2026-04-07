export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { activityFeed } from "@/modules/core/schema";
import { loadExportProducts } from "@/modules/catalog/lib/export/load-products";
import {
  createShopifyProduct,
  updateShopifyProduct,
  findShopifyProductBySku,
  hasShopifyCredentials,
  type ShopifyStore,
} from "@/modules/orders/lib/shopify-api";

/**
 * POST /api/v1/catalog/shopify-push
 * Push products directly to Shopify stores via Admin API.
 *
 * Body: { productIds: string[], stores: ("dtc" | "wholesale")[] }
 *
 * Pricing:
 * - DTC store: uses retailPrice, compare_at = MSRP
 * - Wholesale store: uses wholesalePrice, compare_at = retailPrice
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { productIds, stores } = body as {
    productIds: string[];
    stores: ShopifyStore[];
  };

  if (!productIds?.length) {
    return NextResponse.json({ error: "productIds required" }, { status: 400 });
  }
  if (!stores?.length) {
    return NextResponse.json({ error: "stores required (dtc, wholesale)" }, { status: 400 });
  }

  // Validate credentials for requested stores
  for (const store of stores) {
    if (!hasShopifyCredentials(store)) {
      return NextResponse.json(
        { error: `Shopify ${store} credentials not configured` },
        { status: 400 },
      );
    }
  }

  const exportProducts = await loadExportProducts(productIds);
  if (exportProducts.length === 0) {
    return NextResponse.json({ error: "No products found" }, { status: 404 });
  }

  const results: Array<{
    productId: string;
    name: string;
    store: string;
    action: "created" | "updated" | "error";
    shopifyId?: number;
    error?: string;
  }> = [];

  for (const ep of exportProducts) {
    for (const store of stores) {
      try {
        // Determine pricing based on store
        const isWholesale = store === "wholesale";
        const variantPrice = isWholesale
          ? ((ep.wholesalePrice && ep.wholesalePrice > 0) ? ep.wholesalePrice.toFixed(2) : "8.00")
          : ((ep.retailPrice && ep.retailPrice > 0) ? ep.retailPrice.toFixed(2) : "24.00");
        const compareAtPrice = isWholesale
          ? ((ep.retailPrice && ep.retailPrice > 0) ? ep.retailPrice.toFixed(2) : undefined)
          : ((ep.msrp && ep.msrp > 0) ? ep.msrp.toFixed(2) : undefined);

        const approvedImages = ep.images
          .filter((i) => i.status === "approved" && i.filePath)
          .sort((a, b) => (b.isBest ? 1 : 0) - (a.isBest ? 1 : 0));

        const tagString = ep.tags.map((t) => t.tagName).filter(Boolean).join(", ");

        const colorValues = ep.skus.map((s) => s.colorName || "Default").filter(Boolean);
        const hasMultipleVariants = ep.skus.length > 1;

        const variants = ep.skus.map((s) => ({
          sku: s.sku || "",
          price: variantPrice,
          compare_at_price: compareAtPrice,
          option1: s.colorName || "Default Title",
          inventory_management: "shopify" as const,
          barcode: s.upc || undefined,
        }));

        const productPayload = {
          title: ep.product.name || ep.product.skuPrefix,
          body_html: ep.product.description || "",
          vendor: "Jaxy",
          product_type: ep.product.category || "",
          tags: tagString,
          variants,
          options: hasMultipleVariants
            ? [{ name: "Color", values: colorValues }]
            : undefined,
          images: approvedImages.map((img) => ({
            src: img.filePath!,
            alt: ep.product.name || undefined,
          })),
        };

        // Check if product already exists on this store
        const existing = await findShopifyProductBySku(store, ep.product.skuPrefix);

        if (existing) {
          const updated = await updateShopifyProduct(store, String(existing.id), productPayload);
          results.push({
            productId: ep.product.id,
            name: ep.product.name || ep.product.skuPrefix,
            store,
            action: "updated",
            shopifyId: updated.id,
          });
        } else {
          const created = await createShopifyProduct(store, productPayload);
          results.push({
            productId: ep.product.id,
            name: ep.product.name || ep.product.skuPrefix,
            store,
            action: "created",
            shopifyId: created.id,
          });
        }
      } catch (e) {
        results.push({
          productId: ep.product.id,
          name: ep.product.name || ep.product.skuPrefix,
          store,
          action: "error",
          error: String(e),
        });
      }
    }
  }

  const created = results.filter((r) => r.action === "created").length;
  const updated = results.filter((r) => r.action === "updated").length;
  const errors = results.filter((r) => r.action === "error").length;

  // Log to activity feed
  if (created + updated > 0) {
    db.insert(activityFeed).values({
      eventType: "product.shopify_pushed",
      module: "catalog",
      entityType: "product",
      data: { stores, created, updated, errors, count: productIds.length },
    }).run();
  }

  return NextResponse.json({ created, updated, errors, results }, { status: 200 });
}
