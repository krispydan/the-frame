export const dynamic = "force-dynamic";
// 9,006-row CSVs land in ~5-10s on prod sqlite (in-memory test ran in
// under 2s). 300s ceiling gives generous headroom for larger imports
// later, and keeps us well under Cloudflare's edge timeout window.
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import { importStoreLeadsCsv } from "@/modules/sales/lib/storeleads/import";

/**
 * POST /api/v1/integrations/storeleads/import-csv
 *
 * multipart/form-data:
 *   file        — the StoreLeads .csv export (required)
 *   sourceLabel — optional human-friendly label stored on each new row's
 *                 `source` column (e.g. "boutique-womens-clothing-2026-05")
 *
 * Writes the upload to /tmp, runs importStoreLeadsCsv, deletes the tmpfile,
 * and returns the full import stats JSON. See
 * src/modules/sales/lib/storeleads/import.ts for the schema.
 *
 * Re-uploading the same file is safe — dedup is by normalised domain
 * and the merge rule fills nulls without clobbering hand-edited values.
 */
export async function POST(req: NextRequest) {
  let tmpPath: string | null = null;
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const sourceLabel = (formData.get("sourceLabel") as string | null) ?? undefined;

    if (!file) {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }

    // Write the upload to /tmp — the importer streams from a file path
    // (papaparse + better-sqlite3 are easier with disk than buffers).
    tmpPath = path.join(os.tmpdir(), `storeleads-${Date.now()}-${Math.floor(Math.random() * 1e6)}.csv`);
    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(tmpPath, buffer);

    const stats = await importStoreLeadsCsv(tmpPath, {
      sourceLabel: sourceLabel ?? `storeleads_csv:${file.name}`,
    });
    return NextResponse.json({ ok: true, fileName: file.name, stats });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  } finally {
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
    }
  }
}
