/**
 * POST /api/v1/catalog/photos/bulk — multipart bulk photo upload for
 * the UI's drag-and-drop. Each file routes itself by canonical filename
 * (photo-kinds.ts); optional per-request `sku`/`kind` fields force
 * routing for every file in the batch. Same ingest lib as the MCP tool.
 *
 * Also handles preflight: POST with `namesJson` (no files) dry-runs the
 * router so the UI can show where files WILL land before uploading.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { ingestRoutedPhoto, routePhotoFileName } from "@/modules/catalog/lib/photo-ingest";

export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Multipart form body required" }, { status: 400 });

  // ── dry-run mode ──
  const namesJson = form.get("namesJson");
  if (typeof namesJson === "string" && namesJson) {
    try {
      const names: string[] = JSON.parse(namesJson);
      return NextResponse.json({
        results: names.map((n) => {
          const r = routePhotoFileName(String(n));
          return r.target
            ? { fileName: n, ok: true, sku: r.target.sku, kind: r.target.kind, angle: r.target.angleSlug, productScope: r.target.productScope }
            : { fileName: n, ok: false, error: r.error };
        }),
      });
    } catch {
      return NextResponse.json({ error: "namesJson must be a JSON array" }, { status: 400 });
    }
  }

  // ── upload mode ──
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (!files.length) return NextResponse.json({ error: "No files" }, { status: 400 });
  if (files.length > 40) return NextResponse.json({ error: "Max 40 files per request" }, { status: 413 });

  const forceSku = typeof form.get("sku") === "string" ? String(form.get("sku")) : undefined;
  const forceKind = typeof form.get("kind") === "string" ? String(form.get("kind")) : undefined;

  const results = [];
  for (const file of files) {
    results.push(await ingestRoutedPhoto({
      bytes: Buffer.from(await file.arrayBuffer()),
      fileName: file.name,
      sku: forceSku || undefined,
      kind: forceKind || undefined,
    }));
  }
  return NextResponse.json({
    uploaded: results.filter((r) => r.status === "uploaded").length,
    deduped: results.filter((r) => r.status === "deduped").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  });
}
