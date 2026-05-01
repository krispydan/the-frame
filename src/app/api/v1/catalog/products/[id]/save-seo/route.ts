export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { products } from "@/modules/catalog/schema";
import { eq, sql } from "drizzle-orm";
import {
  findShopifyProductBySku,
  shopifyGraphqlRequest,
} from "@/modules/orders/lib/shopify-api";

/**
 * POST /api/v1/catalog/products/{id}/save-seo
 *
 * Saves the provided SEO title + description on the catalog_products
 * row AND pushes them to Shopify retail's product seo.title /
 * seo.description so Simprosys's Google Shopping feed picks them up on
 * its next run.
 *
 * Wholesale is intentionally skipped — Google Shopping is retail-only
 * and pushing duplicate SEO copy to the wholesale store would only
 * confuse buyers there.
 *
 * Body: { title: string, description: string }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";

  if (!title || !description) {
    return NextResponse.json({ error: "title and description required" }, { status: 400 });
  }

  let product = (await db.select().from(products).where(eq(products.id, id)))[0];
  if (!product) {
    product = (await db.select().from(products).where(eq(products.skuPrefix, id)))[0];
  }
  if (!product || !product.skuPrefix) {
    return NextResponse.json({ error: `Product not found: ${id}` }, { status: 404 });
  }

  // 1. Save in the-frame
  await db
    .update(products)
    .set({
      seoTitle: title,
      metaDescription: description,
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(products.id, product.id));

  // 2. Push to Shopify retail (DTC) only. Wholesale skipped intentionally.
  let shopifyResult: { ok: boolean; productId: string | null; error?: string } = {
    ok: false,
    productId: null,
  };
  try {
    const sp = await findShopifyProductBySku("dtc", product.skuPrefix);
    if (!sp) {
      shopifyResult = { ok: false, productId: null, error: "product not found on retail Shopify" };
    } else {
      const productGid = `gid://shopify/Product/${sp.id}`;
      const M = `
        mutation($input: ProductInput!) {
          productUpdate(input: $input) {
            product { id }
            userErrors { field message }
          }
        }
      `;
      type Resp = {
        productUpdate: {
          product: { id: string } | null;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      };
      const res = await shopifyGraphqlRequest<Resp>("dtc", M, {
        input: {
          id: productGid,
          seo: { title, description },
        },
      });
      const errs = res.productUpdate.userErrors;
      if (errs.length > 0) {
        shopifyResult = {
          ok: false,
          productId: String(sp.id),
          error: errs.map((e) => `${(e.field || []).join(".")}: ${e.message}`).join("; "),
        };
      } else {
        shopifyResult = { ok: true, productId: String(sp.id) };
      }
    }
  } catch (e) {
    shopifyResult = {
      ok: false,
      productId: null,
      error: e instanceof Error ? e.message : "unknown",
    };
  }

  return NextResponse.json({
    ok: shopifyResult.ok,
    productId: product.id,
    skuPrefix: product.skuPrefix,
    saved: { title, description },
    shopifyRetail: shopifyResult,
  });
}
