/**
 * Bulk-generate Google Shopping SEO copy for every product, save it,
 * and push to retail Shopify.
 *
 * Default is dry-run — prints generated copy without writing anything.
 * Pass --apply to save + push to Shopify.
 *
 * Usage:
 *   npx tsx scripts/generate-all-seo.ts
 *   npx tsx scripts/generate-all-seo.ts --apply
 *   npx tsx scripts/generate-all-seo.ts --apply --concurrency 3
 *   npx tsx scripts/generate-all-seo.ts --only JX1001,JX2007
 */
import { db, sqlite } from "@/lib/db";
import { products } from "@/modules/catalog/schema";
import { eq, sql } from "drizzle-orm";
import { generateSeoForProduct } from "@/modules/catalog/lib/seo/ai-generate";
import {
  findShopifyProductBySku,
  shopifyGraphqlRequest,
} from "@/modules/orders/lib/shopify-api";

interface RowResult {
  skuPrefix: string;
  name: string;
  status: "ok" | "saved" | "ai_failed" | "shopify_failed" | "skipped";
  titleChars?: number;
  descChars?: number;
  warnings?: string[];
  error?: string;
}

const SHOPIFY_M = `
  mutation($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id }
      userErrors { field message }
    }
  }
`;

async function pushToRetailShopify(
  skuPrefix: string,
  title: string,
  description: string,
): Promise<{ ok: boolean; error?: string }> {
  const sp = await findShopifyProductBySku("dtc", skuPrefix);
  if (!sp) return { ok: false, error: "not on retail Shopify" };
  const productGid = `gid://shopify/Product/${sp.id}`;
  const res = await shopifyGraphqlRequest<{
    productUpdate: { product: { id: string } | null; userErrors: Array<{ field: string[]; message: string }> };
  }>("dtc", SHOPIFY_M, { input: { id: productGid, seo: { title, description } } });
  const errs = res.productUpdate.userErrors;
  if (errs.length > 0) {
    return { ok: false, error: errs.map((e) => `${(e.field || []).join(".")}: ${e.message}`).join("; ") };
  }
  return { ok: true };
}

async function processOne(
  skuPrefix: string,
  productId: string,
  apply: boolean,
): Promise<RowResult> {
  const r = await generateSeoForProduct(productId);
  if (!r.output) {
    return {
      skuPrefix,
      name: "",
      status: "ai_failed",
      error: r.errors.join("; "),
      warnings: r.warnings,
    };
  }
  if (!apply) {
    return {
      skuPrefix,
      name: "",
      status: "ok",
      titleChars: r.output.char_count.title,
      descChars: r.output.char_count.description,
      warnings: r.warnings,
    };
  }

  // Save in the-frame
  await db
    .update(products)
    .set({
      seoTitle: r.output.title,
      metaDescription: r.output.description,
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(products.id, productId));

  // Push to retail
  const push = await pushToRetailShopify(skuPrefix, r.output.title, r.output.description);
  if (!push.ok) {
    return {
      skuPrefix,
      name: "",
      status: "shopify_failed",
      error: push.error,
      titleChars: r.output.char_count.title,
      descChars: r.output.char_count.description,
      warnings: r.warnings,
    };
  }
  return {
    skuPrefix,
    name: "",
    status: "saved",
    titleChars: r.output.char_count.title,
    descChars: r.output.char_count.description,
    warnings: r.warnings,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const concurrencyArg = args.indexOf("--concurrency");
  const concurrency = concurrencyArg !== -1 ? Number(args[concurrencyArg + 1]) || 2 : 2;
  const onlyArg = args.indexOf("--only");
  const onlySet = onlyArg !== -1
    ? new Set(args[onlyArg + 1].split(",").map((s) => s.trim().toUpperCase()))
    : null;

  const allProducts = await db.select().from(products);
  const target = allProducts
    .filter((p) => p.skuPrefix && (!onlySet || onlySet.has(p.skuPrefix.toUpperCase())))
    .sort((a, b) => (a.skuPrefix || "").localeCompare(b.skuPrefix || ""));

  console.log(`Mode: ${apply ? "LIVE (saves + pushes to retail Shopify)" : "DRY RUN (no writes)"}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Targets: ${target.length} products\n`);

  // Simple promise-pool concurrency
  const queue = [...target];
  const results: RowResult[] = [];
  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const p = queue.shift();
          if (!p || !p.skuPrefix) continue;
          process.stdout.write(`▶ ${p.skuPrefix.padEnd(8)} ${(p.name || "?").padEnd(20)} `);
          try {
            const r = await processOne(p.skuPrefix, p.id, apply);
            r.name = p.name ?? "";
            results.push(r);
            const tag = r.status === "saved" ? "✓ saved" :
              r.status === "ok" ? `✓ generated (t=${r.titleChars}, d=${r.descChars})` :
              r.status === "ai_failed" ? `✗ AI: ${r.error}` :
              r.status === "shopify_failed" ? `✗ Shopify: ${r.error}` :
              `· ${r.status}`;
            console.log(tag);
            if (r.warnings && r.warnings.length > 0) {
              console.log(`    ⚠ ${r.warnings.join("; ")}`);
            }
          } catch (e) {
            results.push({ skuPrefix: p.skuPrefix, name: p.name ?? "", status: "ai_failed", error: e instanceof Error ? e.message : "?" });
            console.log(`✗ THROW: ${e instanceof Error ? e.message : e}`);
          }
        }
      })(),
    );
  }
  await Promise.all(workers);

  // Summary
  const tally = { ok: 0, saved: 0, ai_failed: 0, shopify_failed: 0, skipped: 0 };
  for (const r of results) tally[r.status]++;
  console.log(`\n══════ Summary ══════`);
  console.log(`  generated ok: ${tally.ok}`);
  console.log(`  saved + pushed: ${tally.saved}`);
  console.log(`  AI failed: ${tally.ai_failed}`);
  console.log(`  Shopify failed: ${tally.shopify_failed}`);

  // Close DB
  sqlite.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
