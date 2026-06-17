export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * POST /api/admin/catalog/import-po
 *
 * Bulk-create new catalog products + their colorway SKUs + (for reading
 * glasses) the per-power variant SKUs, from a parsed Master PO payload.
 *
 * Generated upstream by scripts/parse-master-po.py — that script reads
 * the Jaxy Master PO Excel sheet, filters to Status=New rows only
 * (skipping reorder rows that already exist in prod under the old SKU
 * format), and produces this JSON shape:
 *
 *   {
 *     products: [
 *       {
 *         skuPrefix: "JX1019",
 *         name: "Footnote",
 *         type: "sunglasses" | "reading_glasses",
 *         factory: "Taga",
 *         po: "JAX101",
 *         skus: [
 *           {
 *             sku: "JX1019-R-BLK",
 *             colorCode: "BLK",
 *             colorName: "Black",
 *             upc: "605547...",
 *             costPrice: 1.05,
 *             qty: 300,
 *             // For reading glasses only:
 *             powerVariants: [
 *               { sku: "JX1019-R-BLK-BL",  readingPower: 0.0,  hasBlueLightFilter: true,  upc, costPrice },
 *               { sku: "JX1019-R-BLK-100", readingPower: 1.0,  hasBlueLightFilter: false, upc, costPrice },
 *               ...
 *             ],
 *           }, ...
 *         ],
 *       }, ...
 *     ]
 *   }
 *
 * Idempotency:
 *   - Products keyed by (skuPrefix). If a product with the same prefix
 *     already exists, it is left untouched and its SKUs are not duplicated.
 *   - SKUs keyed by (sku). If a row with the same sku string already
 *     exists, it is skipped — the UNIQUE constraint on catalog_skus.sku
 *     enforces this at the DB layer too.
 *
 * Body:
 *   {
 *     payload: { products: [...] }       // the JSON from parse-master-po.py
 *     dryRun?: boolean                    // default false
 *   }
 *
 * Auth: x-admin-key: jaxy2026
 */

interface PowerVariant {
  sku: string;
  upc: string | null;
  costPrice: number | null;
  readingPower: number;
  hasBlueLightFilter: boolean;
}
interface Colorway {
  sku: string;
  colorCode: string;
  colorName: string;
  upc: string | null;
  costPrice: number | null;
  qty: number | null;
  powerVariants?: PowerVariant[];
}
interface ProductEntry {
  skuPrefix: string;
  name: string;
  type: "sunglasses" | "reading_glasses";
  factory: string;
  po: string;
  skus: Colorway[];
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { payload?: { products?: ProductEntry[] }; dryRun?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  const products = body.payload?.products;
  if (!Array.isArray(products) || products.length === 0) {
    return NextResponse.json(
      { error: "payload.products[] required" },
      { status: 400 },
    );
  }
  const dryRun = body.dryRun === true;

  // Snapshot existing prefixes + SKUs so we can detect conflicts.
  const existingPrefixes = new Set(
    (sqlite.prepare("SELECT sku_prefix FROM catalog_products WHERE sku_prefix IS NOT NULL").all() as Array<{
      sku_prefix: string;
    }>).map((r) => r.sku_prefix),
  );
  const existingSkus = new Set(
    (sqlite.prepare("SELECT sku FROM catalog_skus WHERE sku IS NOT NULL").all() as Array<{
      sku: string;
    }>).map((r) => r.sku),
  );

  type PlanRow = { kind: "product" | "colorway" | "power"; sku: string; detail: string };
  const plan: PlanRow[] = [];
  const skipped: PlanRow[] = [];

  // Build the plan. We do a non-DB walk so dry-run is a pure preview.
  const productInsertPlan: Array<{ id: string; entry: ProductEntry }> = [];
  const skuInsertPlan: Array<{
    id: string;
    productId: string;
    sku: string;
    colorName: string;
    upc: string | null;
    costPrice: number | null;
    readingPower: number | null;
    hasBlueLightFilter: boolean | null;
  }> = [];

  // We need to know each product's id at insert time. For new products
  // we mint a uuid here. For existing prefixes we look up the id.
  const prefixToId = new Map<string, string>();
  for (const e of products) {
    if (existingPrefixes.has(e.skuPrefix)) {
      const row = sqlite
        .prepare("SELECT id FROM catalog_products WHERE sku_prefix = ?")
        .get(e.skuPrefix) as { id: string } | undefined;
      if (row) {
        prefixToId.set(e.skuPrefix, row.id);
        skipped.push({
          kind: "product",
          sku: e.skuPrefix,
          detail: `product already exists (${e.name})`,
        });
      }
    } else {
      const id = crypto.randomUUID();
      prefixToId.set(e.skuPrefix, id);
      productInsertPlan.push({ id, entry: e });
      plan.push({
        kind: "product",
        sku: e.skuPrefix,
        detail: `${e.name} (${e.type}, ${e.factory}/${e.po})`,
      });
    }
  }

  // Colorway + power-variant SKUs
  for (const e of products) {
    const productId = prefixToId.get(e.skuPrefix);
    if (!productId) continue;
    for (const c of e.skus) {
      if (existingSkus.has(c.sku)) {
        skipped.push({
          kind: "colorway",
          sku: c.sku,
          detail: `SKU already exists (${c.colorName})`,
        });
      } else {
        skuInsertPlan.push({
          id: crypto.randomUUID(),
          productId,
          sku: c.sku,
          colorName: c.colorName,
          upc: c.upc,
          costPrice: c.costPrice,
          readingPower: null,
          hasBlueLightFilter: null,
        });
        plan.push({
          kind: "colorway",
          sku: c.sku,
          detail: `${c.colorName}  UPC ${c.upc}  $${c.costPrice}`,
        });
      }
      // Reading-glasses power variants
      for (const p of c.powerVariants ?? []) {
        if (existingSkus.has(p.sku)) {
          skipped.push({
            kind: "power",
            sku: p.sku,
            detail: "power SKU already exists",
          });
          continue;
        }
        skuInsertPlan.push({
          id: crypto.randomUUID(),
          productId,
          sku: p.sku,
          colorName: c.colorName,
          upc: p.upc,
          costPrice: p.costPrice,
          readingPower: p.readingPower,
          hasBlueLightFilter: p.hasBlueLightFilter,
        });
        plan.push({
          kind: "power",
          sku: p.sku,
          detail: `+${p.readingPower.toFixed(2)}${p.hasBlueLightFilter ? " BL" : ""}  UPC ${p.upc}`,
        });
      }
    }
  }

  const counts = {
    newProducts: productInsertPlan.length,
    newColorways: skuInsertPlan.filter((s) => s.readingPower == null).length,
    newPowerSkus: skuInsertPlan.filter((s) => s.readingPower != null).length,
    skippedExistingProducts: skipped.filter((s) => s.kind === "product").length,
    skippedExistingSkus: skipped.filter((s) => s.kind !== "product").length,
  };

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      counts,
      preview: {
        products: productInsertPlan.slice(0, 5).map((p) => ({
          skuPrefix: p.entry.skuPrefix,
          name: p.entry.name,
          type: p.entry.type,
          colorways: p.entry.skus.length,
        })),
        sampleSkus: skuInsertPlan.slice(0, 15).map((s) => ({
          sku: s.sku,
          color: s.colorName,
          power: s.readingPower,
          blueLight: s.hasBlueLightFilter,
        })),
      },
      skippedSample: skipped.slice(0, 10),
    });
  }

  // ── Write phase ──
  const insertProduct = sqlite.prepare<unknown[]>(
    `INSERT INTO catalog_products
       (id, sku_prefix, name, status, created_at, updated_at)
     VALUES (?, ?, ?, 'intake', datetime('now'), datetime('now'))`,
  );
  const insertSku = sqlite.prepare<unknown[]>(
    `INSERT INTO catalog_skus
       (id, product_id, sku, color_name, upc, cost_price,
        reading_power, has_blue_light_filter,
        status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'intake', datetime('now'), datetime('now'))`,
  );

  const txn = sqlite.transaction(() => {
    for (const p of productInsertPlan) {
      insertProduct.run(p.id, p.entry.skuPrefix, p.entry.name);
    }
    for (const s of skuInsertPlan) {
      insertSku.run(
        s.id,
        s.productId,
        s.sku,
        s.colorName,
        s.upc,
        s.costPrice,
        s.readingPower,
        s.hasBlueLightFilter == null ? null : s.hasBlueLightFilter ? 1 : 0,
      );
    }
  });
  txn();

  return NextResponse.json({
    ok: true,
    counts,
    sampleCreated: skuInsertPlan.slice(0, 10).map((s) => ({
      sku: s.sku,
      color: s.colorName,
      power: s.readingPower,
      blueLight: s.hasBlueLightFilter,
    })),
  });
}
