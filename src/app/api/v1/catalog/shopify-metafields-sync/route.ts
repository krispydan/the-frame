export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { products } from "@/modules/catalog/schema";
import { activityFeed } from "@/modules/core/schema";
import { eq, inArray } from "drizzle-orm";
import { loadExportProducts } from "@/modules/catalog/lib/export/load-products";
import {
  findShopifyProductBySku,
  hasShopifyCredentials,
  type ShopifyStore,
} from "@/modules/orders/lib/shopify-api";
import { categorizeProduct } from "@/modules/catalog/lib/shopify-metafields/ai-categorize";
import { syncProductMetafields } from "@/modules/catalog/lib/shopify-metafields/sync";
import type { AiCategorizationOutput } from "@/modules/catalog/lib/shopify-metafields/handles";

/**
 * POST /api/v1/catalog/shopify-metafields-sync
 *
 * Body:
 *   {
 *     productIds: string[],            // Jaxy catalog product IDs (UUIDs)
 *     stores: ("dtc" | "wholesale")[], // target stores
 *     dryRun?: boolean,                // don't actually write, return inputs
 *     force?: boolean,                 // re-run AI even if we have cached categorization
 *   }
 *
 * For each product:
 *   1. Load or generate AI categorization (cached in catalog_products)
 *   2. Look up the Shopify product by SKU prefix on each store
 *   3. Run the sync orchestrator: set category + write metafields
 *
 * Returns a detailed per-product × per-store report.
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const {
    productIds,
    stores,
    dryRun = false,
    force = false,
  } = body as {
    productIds: string[];
    stores: ShopifyStore[];
    dryRun?: boolean;
    force?: boolean;
  };

  if (!productIds?.length) {
    return NextResponse.json({ error: "productIds required" }, { status: 400 });
  }
  if (!stores?.length) {
    return NextResponse.json({ error: "stores required (dtc, wholesale)" }, { status: 400 });
  }

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

  // Pull the raw product rows too — we need the cached ai_categorization column
  const rawProducts = await db
    .select()
    .from(products)
    .where(inArray(products.id, productIds));
  const rawById = new Map(rawProducts.map((p) => [p.id, p]));

  interface Report {
    productId: string;
    productName: string;
    skuPrefix: string;
    aiUsed: "cached" | "fresh" | "failed";
    aiProblems: string[];
    stores: Array<{
      store: ShopifyStore;
      shopifyProductId?: string;
      ok: boolean;
      categorySet: boolean;
      categoryError?: string;
      metafieldsWritten: number;
      metafieldsAttempted: number;
      metafieldErrors: string[];
      problems: string[];
      dryRunInputs?: unknown;
    }>;
  }

  const report: Report[] = [];

  for (const ep of exportProducts) {
    const raw = rawById.get(ep.product.id);
    if (!raw) continue;

    // ── Step 1: Get or generate AI categorization ──
    let categorization: AiCategorizationOutput | null = null;
    let aiUsed: Report["aiUsed"] = "cached";
    const aiProblems: string[] = [];

    if (!force && raw.aiCategorization) {
      try {
        categorization = JSON.parse(raw.aiCategorization) as AiCategorizationOutput;
      } catch {
        aiProblems.push("cached ai_categorization failed to parse; regenerating");
        categorization = null;
      }
    }

    if (!categorization) {
      aiUsed = "fresh";
      const firstSku = ep.skus[0];
      const catResult = await categorizeProduct({
        productId: ep.product.id,
        name: ep.product.name || ep.product.skuPrefix,
        colorName: firstSku?.colorName || null,
        description: ep.product.description,
        frameShape: ep.product.frameShape,
        gender: ep.product.gender,
        // TODO(image): pass the primary product image URL once the image
        // pipeline is live. Text-only categorization is less accurate for
        // frame shape detection.
        imageUrl: null,
      });

      if (catResult.output) {
        categorization = catResult.output;
        aiProblems.push(...catResult.problems.map((p) => `${p.field}: ${p.message}`));

        // Cache it back to the DB
        if (!dryRun) {
          await db
            .update(products)
            .set({
              aiCategorization: JSON.stringify(categorization),
              aiCategorizedAt: new Date().toISOString(),
              aiCategorizationModel: catResult.model,
            })
            .where(eq(products.id, ep.product.id));
        }
      } else {
        aiUsed = "failed";
        aiProblems.push(catResult.error || "unknown AI error");
        aiProblems.push(...catResult.problems.map((p) => `${p.field}: ${p.message}`));
      }
    }

    const productReport: Report = {
      productId: ep.product.id,
      productName: ep.product.name || ep.product.skuPrefix,
      skuPrefix: ep.product.skuPrefix,
      aiUsed,
      aiProblems,
      stores: [],
    };

    if (!categorization) {
      // No categorization = nothing to sync; still record the attempt per store.
      for (const store of stores) {
        productReport.stores.push({
          store,
          ok: false,
          categorySet: false,
          metafieldsWritten: 0,
          metafieldsAttempted: 0,
          metafieldErrors: [],
          problems: ["No AI categorization available"],
        });
      }
      report.push(productReport);
      continue;
    }

    // ── Step 2: Per-store sync ──
    for (const store of stores) {
      try {
        const existing = await findShopifyProductBySku(store, ep.product.skuPrefix);
        if (!existing) {
          productReport.stores.push({
            store,
            ok: false,
            categorySet: false,
            metafieldsWritten: 0,
            metafieldsAttempted: 0,
            metafieldErrors: [],
            problems: [`Product not found on ${store} (SKU prefix ${ep.product.skuPrefix})`],
          });
          continue;
        }

        const syncRes = await syncProductMetafields({
          store,
          shopifyProductId: String(existing.id),
          categorization,
          dryRun,
        });

        productReport.stores.push({
          store,
          shopifyProductId: String(existing.id),
          ok: syncRes.ok,
          categorySet: syncRes.categorySet,
          categoryError: syncRes.categoryError,
          metafieldsWritten: syncRes.metafieldsWritten,
          metafieldsAttempted: syncRes.metafieldsAttempted,
          metafieldErrors: syncRes.metafieldErrors.map((e) => e.message),
          problems: syncRes.problems,
          dryRunInputs: dryRun ? syncRes.metafieldInputs : undefined,
        });
      } catch (e) {
        productReport.stores.push({
          store,
          ok: false,
          categorySet: false,
          metafieldsWritten: 0,
          metafieldsAttempted: 0,
          metafieldErrors: [],
          problems: [String(e)],
        });
      }
    }

    report.push(productReport);
  }

  // Summary counts
  const totalWrites = report.reduce(
    (sum, r) => sum + r.stores.reduce((s, st) => s + st.metafieldsWritten, 0),
    0,
  );
  const totalErrors = report.reduce(
    (sum, r) => sum + r.stores.filter((s) => !s.ok).length,
    0,
  );
  const aiFreshRuns = report.filter((r) => r.aiUsed === "fresh").length;

  if (!dryRun && totalWrites > 0) {
    db.insert(activityFeed)
      .values({
        eventType: "product.metafields_synced",
        module: "catalog",
        entityType: "product",
        data: {
          stores,
          productCount: productIds.length,
          totalWrites,
          totalErrors,
          aiFreshRuns,
        },
      })
      .run();
  }

  return NextResponse.json(
    { totalWrites, totalErrors, aiFreshRuns, dryRun, report },
    { status: 200 },
  );
}
