export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { READING_POWERS, readingSkuSuffix } from "@/modules/catalog/lib/reading-glasses";

/**
 * POST /api/admin/catalog/generate-reading-skus
 *
 * Fan out reading-glasses variant SKUs for a product. For each
 * (frameColor) × (power ∈ READING_POWERS) × (hasBlueLight ∈ {true,false})
 * combo, insert a SKU row if one doesn't already exist for that combo.
 *
 * Use case: Daniel just added a "Reading Glasses — Aria" product with the
 * reading category tag and one frame color (Black). One button click
 * generates the 12 variant SKUs (6 powers × {regular, blue light}).
 *
 * Body:
 *   {
 *     productId: string,
 *     colors: [{ name: "Black", code: "BLK", hex?: "#000000" }, ...],
 *     dryRun?: boolean         // default false; if true, lists what would
 *                              // be created without writing
 *   }
 *
 * SKU code format: `{skuPrefix}-{colorCode}-{powerSuffix}`
 *   JX2001-BLK-150     → +1.50, no blue light
 *   JX2001-BLK-150-BL  → +1.50, blue light
 *
 * Idempotent: re-running with the same input creates no duplicates.
 *
 * Auth: x-admin-key: jaxy2026
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    productId?: string;
    colors?: Array<{ name: string; code: string; hex?: string }>;
    dryRun?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }

  if (!body.productId) {
    return NextResponse.json({ error: "productId required" }, { status: 400 });
  }
  if (!Array.isArray(body.colors) || body.colors.length === 0) {
    return NextResponse.json(
      { error: "colors[] required (e.g. [{name:'Black', code:'BLK'}])" },
      { status: 400 },
    );
  }
  const dryRun = body.dryRun === true;

  const product = sqlite
    .prepare("SELECT id, sku_prefix FROM catalog_products WHERE id = ?")
    .get(body.productId) as { id: string; sku_prefix: string | null } | undefined;
  if (!product) {
    return NextResponse.json({ error: "product not found" }, { status: 404 });
  }
  if (!product.sku_prefix) {
    return NextResponse.json(
      { error: "product has no skuPrefix — set it before generating SKUs" },
      { status: 400 },
    );
  }

  // Existing SKUs for this product — used to skip duplicates by composite key
  // (color_name, reading_power, has_blue_light_filter).
  const existing = sqlite
    .prepare(
      `SELECT sku, color_name, reading_power, has_blue_light_filter
         FROM catalog_skus
        WHERE product_id = ?`,
    )
    .all(body.productId) as Array<{
      sku: string | null;
      color_name: string | null;
      reading_power: number | null;
      has_blue_light_filter: number | null;
    }>;
  const seen = new Set(
    existing
      .filter((r) => r.color_name && r.reading_power != null)
      .map(
        (r) =>
          `${r.color_name!.toLowerCase()}|${r.reading_power}|${r.has_blue_light_filter ?? 0}`,
      ),
  );

  type Plan = {
    sku: string;
    colorName: string;
    colorCode: string;
    colorHex: string | null;
    readingPower: number;
    hasBlueLightFilter: boolean;
  };
  const plan: Plan[] = [];
  const skipped: string[] = [];

  for (const c of body.colors) {
    if (!c.name?.trim() || !c.code?.trim()) {
      return NextResponse.json(
        { error: "each color requires both name and code" },
        { status: 400 },
      );
    }
    for (const power of READING_POWERS) {
      for (const bl of [false, true]) {
        const key = `${c.name.toLowerCase()}|${power}|${bl ? 1 : 0}`;
        if (seen.has(key)) {
          skipped.push(`${c.name} +${power.toFixed(2)}${bl ? " BL" : ""}`);
          continue;
        }
        plan.push({
          sku: `${product.sku_prefix}-${c.code.toUpperCase()}-${readingSkuSuffix(power, bl)}`,
          colorName: c.name,
          colorCode: c.code.toUpperCase(),
          colorHex: c.hex ?? null,
          readingPower: power,
          hasBlueLightFilter: bl,
        });
      }
    }
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      product_id: body.productId,
      sku_prefix: product.sku_prefix,
      would_create: plan.length,
      already_exist: skipped.length,
      preview: plan.slice(0, 20),
      skipped_sample: skipped.slice(0, 10),
    });
  }

  const insertStmt = sqlite.prepare(
    `INSERT INTO catalog_skus
       (id, product_id, sku, color_name, color_hex, reading_power,
        has_blue_light_filter, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'intake', datetime('now'), datetime('now'))`,
  );
  const txn = sqlite.transaction(() => {
    for (const p of plan) {
      insertStmt.run(
        crypto.randomUUID(),
        body.productId!,
        p.sku,
        p.colorName,
        p.colorHex,
        p.readingPower,
        p.hasBlueLightFilter ? 1 : 0,
      );
    }
  });
  txn();

  return NextResponse.json({
    ok: true,
    product_id: body.productId,
    sku_prefix: product.sku_prefix,
    created: plan.length,
    already_existed: skipped.length,
    sample: plan.slice(0, 10).map((p) => ({
      sku: p.sku,
      color: p.colorName,
      power: p.readingPower,
      blueLight: p.hasBlueLightFilter,
    })),
  });
}
