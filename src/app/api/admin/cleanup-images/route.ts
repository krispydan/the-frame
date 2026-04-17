/**
 * POST /api/admin/cleanup-images
 *
 * Demotes stale duplicate catalog_images rows to status='superseded'.
 * For each (sku_id, source, image_type_id, position) group with >1
 * approved row, keeps the latest by created_at and demotes the rest.
 *
 * Body: { dryRun?: boolean, sources?: string[] }
 *   dryRun defaults to true.
 *
 * Response: { dryRun, total_demoted, affected_by_source, sample_ids }
 *
 * Reversibility: UPDATE catalog_images SET status='approved'
 *   WHERE status='superseded' AND id IN (<sample_ids>) -- reverses the operation.
 *
 * Auth: x-admin-key: jaxy2026
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-auth";

type StaleRow = { id: string; source: string | null };

export async function POST(request: NextRequest) {
  const deny = requireAdmin(request);
  if (deny) return deny;

  let body: { dryRun?: boolean; sources?: string[] };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const dryRun = body.dryRun !== false; // default safe
  const sourceFilter = body.sources && body.sources.length > 0 ? body.sources : null;

  // Find every approved row that is NOT the newest in its dedup group.
  // Dedup key: (sku_id, source, image_type_id, position).
  // ROW_NUMBER() over created_at DESC → rn=1 is newest; rn>1 is stale.
  let sql = `
    WITH ranked AS (
      SELECT id, source,
        ROW_NUMBER() OVER (
          PARTITION BY sku_id, source, image_type_id, position
          ORDER BY created_at DESC, id DESC
        ) AS rn
      FROM catalog_images
      WHERE status = 'approved'
  `;
  const params: unknown[] = [];
  if (sourceFilter) {
    sql += ` AND source IN (${sourceFilter.map(() => "?").join(",")})`;
    params.push(...sourceFilter);
  }
  sql += `
    )
    SELECT id, source FROM ranked WHERE rn > 1
  `;

  const stale = sqlite.prepare(sql).all(...params) as StaleRow[];

  const affectedBySource: Record<string, number> = {};
  for (const r of stale) {
    const k = r.source ?? "(null)";
    affectedBySource[k] = (affectedBySource[k] ?? 0) + 1;
  }

  const sampleIds = stale.slice(0, 20).map((r) => r.id);

  if (!dryRun && stale.length > 0) {
    const stmt = sqlite.prepare("UPDATE catalog_images SET status = 'superseded' WHERE id = ?");
    const trx = sqlite.transaction((ids: string[]) => {
      for (const id of ids) stmt.run(id);
    });
    trx(stale.map((r) => r.id));
  }

  return NextResponse.json({
    dryRun,
    total_demoted: stale.length,
    affected_by_source: affectedBySource,
    sample_ids: sampleIds,
  });
}
