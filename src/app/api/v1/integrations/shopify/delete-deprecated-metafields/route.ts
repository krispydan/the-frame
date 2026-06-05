export const dynamic = "force-dynamic";
// Iterating all products × both stores can take a minute or two when
// Shopify's GraphQL is slow. 5 min ceiling matches the cron's tolerance.
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { products } from "@/modules/catalog/schema";
import {
  findShopifyProductBySku,
  shopifyGraphqlRequest,
  type ShopifyStore,
} from "@/modules/orders/lib/shopify-api";

const DELETE_MUTATION = `
  mutation($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields {
        key
        namespace
        ownerId
      }
      userErrors { field message }
    }
  }
`;

/**
 * POST /api/v1/integrations/shopify/delete-deprecated-metafields
 *
 * Deletes the deprecated `custom.frame_shape` metafield from every
 * Jaxy product on both Shopify stores. Server-side wrapper around
 * scripts/delete-deprecated-shopify-metafields.ts so Daniel can trigger
 * it via curl against prod instead of running tsx locally.
 *
 * Body (all optional):
 *   {
 *     dryRun?: boolean    // default true; pass false to actually delete
 *     store?: "dtc" | "wholesale"   // default: both
 *     limit?: number     // cap on number of products to walk (debug)
 *   }
 *
 * Returns per-store totals so a partial run can be retried safely
 * (Shopify's metafieldsDelete is idempotent — deleting a non-existent
 * metafield is a clean no-op).
 */
export async function POST(req: NextRequest) {
  let body: { dryRun?: boolean; store?: ShopifyStore; limit?: number } = {};
  try { body = await req.json(); } catch { /* ok */ }

  const apply = body.dryRun === false;
  const stores: ShopifyStore[] =
    body.store === "dtc" || body.store === "wholesale" ? [body.store] : ["dtc", "wholesale"];
  const limit = body.limit && body.limit > 0 ? body.limit : 0;

  const allProducts = await db.select().from(products);
  const candidates = limit > 0 ? allProducts.slice(0, limit) : allProducts;
  const withSku = candidates.filter((p) => !!p.skuPrefix);

  const totals: Record<string, {
    productsWithShopifyMatch: number;
    deleted: number;
    failed: number;
    failures: Array<{ sku: string; error: string }>;
  }> = {};
  for (const s of stores) {
    totals[s] = {
      productsWithShopifyMatch: 0,
      deleted: 0,
      failed: 0,
      failures: [],
    };
  }

  for (const product of withSku) {
    for (const store of stores) {
      const sp = await findShopifyProductBySku(store, product.skuPrefix!);
      if (!sp) continue;
      totals[store].productsWithShopifyMatch++;

      if (!apply) continue;

      const productGid = `gid://shopify/Product/${sp.id}`;
      try {
        const res = await shopifyGraphqlRequest<{
          metafieldsDelete: {
            deletedMetafields: Array<{ key: string; namespace: string }>;
            userErrors: Array<{ field: string[] | null; message: string }>;
          };
        }>(store, DELETE_MUTATION, {
          metafields: [
            { ownerId: productGid, namespace: "custom", key: "frame_shape" },
          ],
        });
        const errs = res.metafieldsDelete.userErrors;
        if (errs.length > 0) {
          totals[store].failed++;
          totals[store].failures.push({
            sku: product.skuPrefix!,
            error: errs.map((e) => e.message).join("; "),
          });
        } else {
          totals[store].deleted += res.metafieldsDelete.deletedMetafields.length;
        }
      } catch (e) {
        totals[store].failed++;
        totals[store].failures.push({
          sku: product.skuPrefix!,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return NextResponse.json({
    ok: true,
    dryRun: !apply,
    scoped: {
      productsScanned: withSku.length,
      stores,
    },
    totals,
  });
}
