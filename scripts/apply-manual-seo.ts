/**
 * Read a JSON file of manually-written SEO copy and apply it to each
 * product: save in catalog_products and push to retail Shopify.
 *
 * Input file format:
 *   [{ "skuPrefix": "JX1001", "title": "...", "description": "..." }, ...]
 *
 * Usage:
 *   npx tsx scripts/apply-manual-seo.ts /tmp/manual-seo.json            # dry
 *   npx tsx scripts/apply-manual-seo.ts /tmp/manual-seo.json --apply
 */
import { db, sqlite } from "@/lib/db";
import { products } from "@/modules/catalog/schema";
import { eq, sql } from "drizzle-orm";
import {
  findShopifyProductBySku,
  shopifyGraphqlRequest,
} from "@/modules/orders/lib/shopify-api";
import * as fs from "fs";

const SHOPIFY_M = `
  mutation($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id }
      userErrors { field message }
    }
  }
`;

interface Entry {
  skuPrefix: string;
  title: string;
  description: string;
}

async function pushRetail(skuPrefix: string, title: string, description: string) {
  const sp = await findShopifyProductBySku("dtc", skuPrefix);
  if (!sp) return { ok: false, error: "not on retail Shopify" };
  const productGid = `gid://shopify/Product/${sp.id}`;
  const res = await shopifyGraphqlRequest<{
    productUpdate: { product: { id: string } | null; userErrors: Array<{ field: string[]; message: string }> };
  }>("dtc", SHOPIFY_M, { input: { id: productGid, seo: { title, description } } });
  const errs = res.productUpdate.userErrors;
  if (errs.length > 0) return { ok: false, error: errs.map((e) => `${(e.field || []).join(".")}: ${e.message}`).join("; ") };
  return { ok: true };
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const apply = args.includes("--apply");
  if (!file) { console.error("usage: apply-manual-seo.ts <path-to-json> [--apply]"); process.exit(1); }
  if (!fs.existsSync(file)) { console.error(`file not found: ${file}`); process.exit(1); }

  const entries = JSON.parse(fs.readFileSync(file, "utf8")) as Entry[];
  console.log(`Mode: ${apply ? "LIVE (saves + pushes)" : "DRY RUN"}`);
  console.log(`Entries: ${entries.length}\n`);

  let saved = 0, failed = 0;
  for (const e of entries) {
    const titleLen = e.title.length, descLen = e.description.length;
    process.stdout.write(`▶ ${e.skuPrefix.padEnd(8)}  t=${titleLen.toString().padStart(3)}  d=${descLen.toString().padStart(3)}  `);

    if (titleLen > 130) console.log(`✗ title too long (>${130})`);
    else if (titleLen < 50) console.log(`✗ title too short (<50)`);
    else if (descLen > 1000) console.log(`✗ description too long (>${1000})`);
    else if (descLen < 300) console.log(`✗ description too short (<300)`);
    else {
      if (!apply) { console.log(`✓ would save`); continue; }
      const product = (await db.select().from(products).where(eq(products.skuPrefix, e.skuPrefix)))[0];
      if (!product) { console.log(`✗ not found`); failed++; continue; }
      await db.update(products).set({
        seoTitle: e.title,
        metaDescription: e.description,
        updatedAt: sql`(datetime('now'))`,
      }).where(eq(products.id, product.id));
      const push = await pushRetail(e.skuPrefix, e.title, e.description);
      if (push.ok) { console.log(`✓ saved + pushed`); saved++; }
      else { console.log(`⚠ saved locally, Shopify failed: ${push.error}`); failed++; }
    }
  }
  console.log(`\nSaved: ${saved}, Failed: ${failed}`);
  sqlite.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
