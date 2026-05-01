export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { products, skus as skusTable, tags as tagsTable } from "@/modules/catalog/schema";
import { eq } from "drizzle-orm";
import {
  hasShopifyCredentials,
  type ShopifyStore,
} from "@/modules/orders/lib/shopify-api";
import { syncMetafieldsFromTags } from "@/modules/catalog/lib/shopify-metafields/sync-from-tags";

/**
 * POST /api/v1/catalog/products/{id}/sync-shopify-metafields-from-tags
 *
 * Body:
 *   {
 *     stores?: ("dtc" | "wholesale")[],   // default: ["dtc", "wholesale"]
 *     dryRun?: boolean,                   // default: false
 *   }
 *
 * Pushes the three tag-curated metafields (lens-polarization,
 * eyewear-frame-design, target-gender) for ONE product to the requested
 * Shopify stores. Returns per-store results so the UI can show
 * resolution detail + warnings.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const stores: ShopifyStore[] = Array.isArray(body.stores) && body.stores.length > 0
    ? body.stores
    : ["dtc", "wholesale"];
  const dryRun = body.dryRun === true;

  // Resolve the product (id might be the UUID OR the SKU prefix — accept both
  // so the catalog page can call with either form)
  let product = (await db.select().from(products).where(eq(products.id, id)))[0];
  if (!product) {
    product = (await db.select().from(products).where(eq(products.skuPrefix, id)))[0];
  }
  if (!product) {
    return NextResponse.json({ error: `Product not found: ${id}` }, { status: 404 });
  }

  // Validate Shopify credentials for each requested store
  const credChecks: Array<{ store: ShopifyStore; ok: boolean }> = [];
  for (const s of stores) credChecks.push({ store: s, ok: await hasShopifyCredentials(s) });
  const missing = credChecks.filter((c) => !c.ok).map((c) => c.store);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Shopify not configured for store(s): ${missing.join(", ")}` },
      { status: 400 },
    );
  }

  // Load the curated tags + SKU color names for this product
  const tagRows = await db.select().from(tagsTable).where(eq(tagsTable.productId, product.id));
  const skuRows = await db.select({ colorName: skusTable.colorName }).from(skusTable).where(eq(skusTable.productId, product.id));

  // Run the sync per store in parallel
  const perStore = await Promise.all(
    stores.map((store) =>
      syncMetafieldsFromTags({
        store,
        skuPrefix: product!.skuPrefix!,
        tags: tagRows.map((t) => ({ dimension: t.dimension ?? "", tagName: t.tagName ?? null })),
        skuColorNames: skuRows.map((s) => s.colorName),
        dryRun,
      }),
    ),
  );

  const ok = perStore.every((r) => r.ok);
  return NextResponse.json({
    ok,
    productId: product.id,
    skuPrefix: product.skuPrefix,
    productName: product.name,
    dryRun,
    stores: perStore,
  }, { status: ok ? 200 : 207 });
}
