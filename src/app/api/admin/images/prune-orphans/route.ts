/**
 * POST /api/admin/images/prune-orphans
 *
 * Delete image objects from R2 that no catalog_images row references any
 * more. Rows can be removed in bulk (deduplication, re-ingests, replaced
 * photo sets) without the underlying object going with them — image keys
 * are content-addressed per SKU (`images/<skuId>/<source>/<sha256>.<ext>`),
 * so a duplicate row has its OWN object rather than sharing one. Those
 * become dead storage.
 *
 * Body:
 *   {
 *     filePaths: string[],   // catalog_images.file_path values to prune
 *                            // (the "<skuId>/<source>/<sha>.<ext>" form)
 *     dryRun?: boolean       // default TRUE — must opt in to deleting
 *   }
 *
 * Safety: every key is re-checked against catalog_images (file_path AND
 * url) immediately before deletion. Anything still referenced is skipped
 * and reported, so a mistaken list can't take out a live image.
 *
 * Response: { dryRun, requested, skippedStillReferenced, deleted, missing, errors }
 *
 * Auth: x-admin-key
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-auth";
import { deleteMedia, mediaStat } from "@/lib/storage/media";

export async function POST(request: NextRequest) {
  const deny = requireAdmin(request);
  if (deny) return deny;

  let body: { filePaths?: string[]; dryRun?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }

  const filePaths = (body.filePaths ?? []).filter((p) => typeof p === "string" && p.length > 0);
  if (filePaths.length === 0) {
    return NextResponse.json({ error: "filePaths[] required" }, { status: 400 });
  }
  const dryRun = body.dryRun !== false; // default safe

  const stillReferenced = sqlite.prepare(
    "SELECT 1 FROM catalog_images WHERE file_path = ? OR url LIKE ? LIMIT 1",
  );

  const skipped: string[] = [];
  const deleted: string[] = [];
  const missing: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  for (const rel of filePaths) {
    // A live row anywhere in the catalog wins — never delete its bytes.
    if (stillReferenced.get(rel, `%${rel}`)) {
      skipped.push(rel);
      continue;
    }
    const key = `images/${rel.replace(/^\/+/, "")}`;
    try {
      const stat = await mediaStat(key);
      if (!stat.exists) {
        missing.push(rel);
        continue;
      }
      if (!dryRun) await deleteMedia(key);
      deleted.push(rel);
    } catch (e: unknown) {
      errors.push({ path: rel, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({
    dryRun,
    requested: filePaths.length,
    skippedStillReferenced: skipped.length,
    deleted: deleted.length,
    missing: missing.length,
    errors: errors.length,
    sampleSkipped: skipped.slice(0, 5),
    sampleErrors: errors.slice(0, 5),
  });
}
