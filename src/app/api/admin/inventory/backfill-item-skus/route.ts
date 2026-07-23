export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * POST /api/admin/inventory/backfill-item-skus?commit=true
 *
 * Backfill order_items.sku_id for rows that have a `sku` string but no FK —
 * historically all Faire-synced lines. Resolution: exact catalog_skus match
 * (case-insensitive), then catalog_sku_aliases. Pack SKUs (…-12PK) are only
 * linked if the pack SKU itself has a catalog row (the forecast resolves
 * packs by string, so no data is faked here).
 *
 * Without commit=true → dry-run report only.
 * Auth: x-admin-key: jaxy2026.
 */

const VERSION = "v1-backfill-item-skus";

export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const stats = sqlite.prepare(`
    SELECT o.channel,
           COUNT(*) AS lines,
           SUM(CASE WHEN oi.sku_id IS NULL THEN 1 ELSE 0 END) AS missing_sku_id
    FROM order_items oi JOIN orders o ON oi.order_id = o.id
    GROUP BY o.channel
  `).all();
  return NextResponse.json({ ok: true, version: VERSION, byChannel: stats });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const commit = new URL(req.url).searchParams.get("commit") === "true";

  const rows = sqlite.prepare(`
    SELECT oi.id, oi.sku
    FROM order_items oi
    WHERE oi.sku_id IS NULL AND oi.sku IS NOT NULL AND oi.sku != ''
  `).all() as Array<{ id: string; sku: string }>;

  const skuLookup = sqlite.prepare("SELECT id FROM catalog_skus WHERE UPPER(sku) = ? LIMIT 1");
  const aliasLookup = sqlite.prepare("SELECT sku_id FROM catalog_sku_aliases WHERE UPPER(alias) = ? LIMIT 1");
  const update = sqlite.prepare("UPDATE order_items SET sku_id = ? WHERE id = ?");

  const cache = new Map<string, string | null>();
  const unresolvedCounts = new Map<string, number>();
  let resolved = 0;

  const apply = sqlite.transaction((pairs: Array<{ id: string; skuId: string }>) => {
    for (const p of pairs) update.run(p.skuId, p.id);
  });
  const pending: Array<{ id: string; skuId: string }> = [];

  for (const row of rows) {
    const up = row.sku.trim().toUpperCase();
    let skuId: string | null;
    if (cache.has(up)) {
      skuId = cache.get(up)!;
    } else {
      skuId = (skuLookup.get(up) as { id: string } | undefined)?.id
        ?? (aliasLookup.get(up) as { sku_id: string } | undefined)?.sku_id
        ?? null;
      cache.set(up, skuId);
    }
    if (skuId) {
      resolved++;
      if (commit) pending.push({ id: row.id, skuId });
    } else {
      unresolvedCounts.set(up, (unresolvedCounts.get(up) ?? 0) + 1);
    }
  }
  if (commit && pending.length) apply(pending);

  const unresolvedTop = [...unresolvedCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([sku, count]) => ({ sku, lines: count }));

  return NextResponse.json({
    ok: true,
    version: VERSION,
    commit,
    counts: {
      missingSkuId: rows.length,
      resolvable: resolved,
      updated: commit ? pending.length : 0,
      unresolvedDistinctSkus: unresolvedCounts.size,
    },
    unresolvedTop,
  });
}
