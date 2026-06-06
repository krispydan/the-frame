export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { curatedAttrsFromTags } from "@/modules/catalog/lib/curated-attributes";

/**
 * POST /api/v1/integrations/amazon/backfill-group-keys
 *
 * Phase 1 backfill, prod-callable version of
 * scripts/backfill-amazon-group-key.ts. Populates
 * catalog_products.amazon_group_key from the curated frameShape tag,
 * and adds a `materialFrame=acetate` tag to any product without one
 * (Raven + Drifter are already correctly tagged `metal` per the
 * Phase 0 audit).
 *
 * Body:
 *   { dryRun?: boolean }   default true
 *
 * Returns:
 *   { ok, planned/applied, skipped, changes[] }
 */

const METAL_SKU_PREFIXES = new Set<string>([]); // Drifter + Raven already tagged

interface ProductRow {
  id: string;
  name: string | null;
  sku_prefix: string | null;
  amazon_group_key: string | null;
}

interface TagRow {
  id: string;
  product_id: string;
  tag_name: string | null;
  dimension: string | null;
}

export async function POST(req: NextRequest) {
  try {
    let body: { dryRun?: boolean } = {};
    try { body = await req.json(); } catch { /* ok */ }
    const apply = body.dryRun === false;

    const products = sqlite.prepare(
      `SELECT id, name, sku_prefix, amazon_group_key FROM catalog_products`,
    ).all() as ProductRow[];

    const tags = sqlite.prepare(
      `SELECT id, product_id, tag_name, dimension FROM catalog_tags`,
    ).all() as TagRow[];
    const tagsByProduct = new Map<string, TagRow[]>();
    for (const t of tags) {
      if (!tagsByProduct.has(t.product_id)) tagsByProduct.set(t.product_id, []);
      tagsByProduct.get(t.product_id)!.push(t);
    }

    interface Change {
      productId: string;
      skuPrefix: string;
      productName: string;
      newAmazonGroupKey?: string;
      addMaterialTag?: "acetate" | "metal";
    }
    const changes: Change[] = [];
    const skipped = { noShape: 0, materialAlreadySet: 0, groupAlreadySet: 0 };

    for (const p of products) {
      const productTags = tagsByProduct.get(p.id) ?? [];
      const curated = curatedAttrsFromTags(
        productTags.map((t) => ({ dimension: t.dimension ?? "", tagName: t.tag_name ?? null })),
      );
      let newGroupKey: string | undefined;
      if (curated.frameShape) {
        const key = curated.frameShape.toLowerCase();
        if (p.amazon_group_key === key) {
          skipped.groupAlreadySet++;
        } else {
          newGroupKey = key;
        }
      } else {
        skipped.noShape++;
      }

      let addMaterialTag: "acetate" | "metal" | undefined;
      const hasMaterialFrameTag = productTags.some(
        (t) => (t.dimension ?? "").toLowerCase() === "materialframe",
      );
      if (!hasMaterialFrameTag) {
        addMaterialTag = METAL_SKU_PREFIXES.has((p.sku_prefix ?? "").toUpperCase())
          ? "metal" : "acetate";
      } else {
        skipped.materialAlreadySet++;
      }

      if (newGroupKey || addMaterialTag) {
        changes.push({
          productId: p.id,
          skuPrefix: p.sku_prefix ?? "(no-prefix)",
          productName: p.name ?? "(unnamed)",
          newAmazonGroupKey: newGroupKey,
          addMaterialTag,
        });
      }
    }

    if (!apply) {
      return NextResponse.json({
        ok: true, dryRun: true,
        plannedChanges: changes.length,
        skipped,
        changes: changes.slice(0, 50),
      });
    }

    const updateGroupKey = sqlite.prepare(
      `UPDATE catalog_products SET amazon_group_key = ?, updated_at = datetime('now')
         WHERE id = ?`,
    );
    const insertTag = sqlite.prepare(
      `INSERT INTO catalog_tags (id, product_id, tag_name, dimension, source)
       VALUES (?, ?, ?, 'materialFrame', 'manual')`,
    );

    let applied = 0;
    const txn = sqlite.transaction(() => {
      for (const c of changes) {
        if (c.newAmazonGroupKey) updateGroupKey.run(c.newAmazonGroupKey, c.productId);
        if (c.addMaterialTag) insertTag.run(crypto.randomUUID(), c.productId, c.addMaterialTag);
        applied++;
      }
    });
    txn();

    return NextResponse.json({
      ok: true,
      applied,
      skipped,
      changesSummary: changes.map((c) => ({
        sku: c.skuPrefix,
        name: c.productName,
        group: c.newAmazonGroupKey,
        material: c.addMaterialTag,
      })),
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack?.split("\n").slice(0, 8).join("\n") : undefined,
      },
      { status: 500 },
    );
  }
}
