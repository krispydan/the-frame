/**
 * One-shot migration: delete the deprecated `custom.frame_shape`
 * metafield from every Jaxy product on both Shopify stores.
 *
 * Brief §1 retired `custom.frame_shape` in favour of the standard
 * `shopify.eyewear-frame-design` taxonomy field (auto-mapped by
 * Simprosys to Google Shopping). Phase 4 already stopped WRITING
 * `custom.frame_shape` in `sync-from-tags.ts`; this script DELETES
 * the values that landed in Shopify before that change.
 *
 * Idempotent — re-running on a product that no longer has the
 * metafield is a no-op (Shopify just returns userErrors=[] when there's
 * nothing to delete).
 *
 * Usage:
 *   npx tsx scripts/delete-deprecated-shopify-metafields.ts            # dry-run
 *   npx tsx scripts/delete-deprecated-shopify-metafields.ts --apply    # writes
 *
 * Optional flags:
 *   --store dtc|wholesale   restrict to one store (default: both)
 *   --limit N               cap on number of products (default: all)
 */

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

interface DeleteResult {
  ok: boolean;
  deleted: number;
  errors: string[];
}

async function deleteFrameShapeFromProduct(
  store: ShopifyStore,
  productGid: string,
): Promise<DeleteResult> {
  try {
    const res = await shopifyGraphqlRequest<{
      metafieldsDelete: {
        deletedMetafields: Array<{ key: string; namespace: string; ownerId: string }>;
        userErrors: Array<{ field: string[] | null; message: string }>;
      };
    }>(store, DELETE_MUTATION, {
      metafields: [
        { ownerId: productGid, namespace: "custom", key: "frame_shape" },
      ],
    });
    return {
      ok: res.metafieldsDelete.userErrors.length === 0,
      deleted: res.metafieldsDelete.deletedMetafields.length,
      errors: res.metafieldsDelete.userErrors.map((e) => e.message),
    };
  } catch (e) {
    return { ok: false, deleted: 0, errors: [e instanceof Error ? e.message : String(e)] };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const storeArg = args[args.indexOf("--store") + 1];
  const limitArg = args[args.indexOf("--limit") + 1];

  const stores: ShopifyStore[] =
    storeArg === "dtc" || storeArg === "wholesale" ? [storeArg] : ["dtc", "wholesale"];
  const limit = limitArg ? parseInt(limitArg, 10) : 0;

  const allProducts = await db.select().from(products);
  const candidates = limit > 0 ? allProducts.slice(0, limit) : allProducts;
  const withSku = candidates.filter((p) => !!p.skuPrefix);

  console.log(`Scope: ${withSku.length} products × ${stores.length} stores`);
  if (!apply) console.log(`(dry-run — pass --apply to write)`);

  const totals: Record<string, { attempted: number; deleted: number; failed: number }> = {};
  for (const s of stores) totals[s] = { attempted: 0, deleted: 0, failed: 0 };

  for (const product of withSku) {
    for (const store of stores) {
      const sp = await findShopifyProductBySku(store, product.skuPrefix!);
      if (!sp) continue;
      const productGid = `gid://shopify/Product/${sp.id}`;
      totals[store].attempted++;

      if (!apply) continue;

      const r = await deleteFrameShapeFromProduct(store, productGid);
      if (r.ok) {
        totals[store].deleted += r.deleted;
        if (r.deleted > 0) {
          console.log(`  ✓ ${product.skuPrefix} ${store}: deleted custom.frame_shape`);
        }
      } else {
        totals[store].failed++;
        console.warn(`  ✗ ${product.skuPrefix} ${store}: ${r.errors.join("; ")}`);
      }
    }
  }

  console.log(`\nTotals:`);
  for (const s of stores) {
    const t = totals[s];
    console.log(`  ${s}: attempted=${t.attempted}, deleted=${t.deleted}, failed=${t.failed}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
