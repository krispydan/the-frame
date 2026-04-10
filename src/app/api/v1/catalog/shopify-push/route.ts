export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { products } from "@/modules/catalog/schema";
import { activityFeed } from "@/modules/core/schema";
import { eq, inArray } from "drizzle-orm";
import { loadExportProducts } from "@/modules/catalog/lib/export/load-products";
import {
  createShopifyProduct,
  updateShopifyProduct,
  findShopifyProductBySku,
  hasShopifyCredentials,
  type ShopifyStore,
} from "@/modules/orders/lib/shopify-api";
import { categorizeProduct } from "@/modules/catalog/lib/shopify-metafields/ai-categorize";
import { syncProductMetafields } from "@/modules/catalog/lib/shopify-metafields/sync";
import type { AiCategorizationOutput } from "@/modules/catalog/lib/shopify-metafields/handles";

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
  const { productIds, stores, syncMetafields = false, force = false } = body as {
    productIds: string[];
    stores: ShopifyStore[];
    syncMetafields?: boolean;
    force?: boolean; // force re-run AI categorization
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
    metafieldsSynced?: number;
    metafieldsErrors?: string[];
  }> = [];

  // Pre-fetch cached AI categorization for each product if metafield sync
  // is enabled. We run the AI once per product (store-agnostic) before
  // looping through stores.
  const categorizationByProductId = new Map<string, AiCategorizationOutput>();
  if (syncMetafields) {
    const rawRows = await db
      .select()
      .from(products)
      .where(inArray(products.id, productIds));

    for (const raw of rawRows) {
      let cached: AiCategorizationOutput | null = null;
      if (!force && raw.aiCategorization) {
        try {
          cached = JSON.parse(raw.aiCategorization) as AiCategorizationOutput;
        } catch {
          cached = null;
        }
      }
      if (cached) {
        categorizationByProductId.set(raw.id, cached);
        continue;
      }

      const ep = exportProducts.find((p) => p.product.id === raw.id);
      if (!ep) continue;
      const firstSku = ep.skus[0];
      const catResult = await categorizeProduct({
        productId: ep.product.id,
        name: ep.product.name || ep.product.skuPrefix,
        colorName: firstSku?.colorName || null,
        description: ep.product.description,
        frameShape: ep.product.frameShape,
        gender: ep.product.gender,
        imageUrl: null, // TODO: pass primary image URL once image pipeline is live
      });
      if (catResult.output) {
        categorizationByProductId.set(raw.id, catResult.output);
        await db
          .update(products)
          .set({
            aiCategorization: JSON.stringify(catResult.output),
            aiCategorizedAt: new Date().toISOString(),
            aiCategorizationModel: catResult.model,
          })
          .where(eq(products.id, raw.id));
      } else {
        console.warn(
          `[shopify-push] AI categorization failed for ${raw.id}:`,
          catResult.error,
          catResult.problems,
        );
      }
    }
  }

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
        let shopifyId: number;
        let action: "created" | "updated";
        if (existing) {
          const updated = await updateShopifyProduct(store, String(existing.id), productPayload);
          shopifyId = updated.id;
          action = "updated";
        } else {
          const created = await createShopifyProduct(store, productPayload);
          shopifyId = created.id;
          action = "created";
        }

        // Optional: sync taxonomy category + metafields after create/update
        let metafieldsSynced: number | undefined;
        let metafieldsErrors: string[] | undefined;
        if (syncMetafields) {
          const categorization = categorizationByProductId.get(ep.product.id);
          if (!categorization) {
            metafieldsErrors = ["No AI categorization available"];
          } else {
            try {
              const syncRes = await syncProductMetafields({
                store,
                shopifyProductId: String(shopifyId),
                categorization,
              });
              metafieldsSynced = syncRes.metafieldsWritten;
              if (!syncRes.ok) {
                metafieldsErrors = [
                  ...(syncRes.categoryError ? [`category: ${syncRes.categoryError}`] : []),
                  ...syncRes.metafieldErrors.map((e) => e.message),
                  ...syncRes.problems,
                ];
              }
            } catch (e) {
              metafieldsErrors = [String(e)];
            }
          }
        }

        results.push({
          productId: ep.product.id,
          name: ep.product.name || ep.product.skuPrefix,
          store,
          action,
          shopifyId,
          metafieldsSynced,
          metafieldsErrors,
        });
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
