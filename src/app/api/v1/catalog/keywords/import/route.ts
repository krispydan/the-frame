export const dynamic = "force-dynamic";
// Cerebro exports run 7k–17k rows; classify + upsert lands in a few
// seconds on prod sqlite. 300s ceiling gives generous headroom.
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import { importCerebroCsv } from "@/modules/catalog/lib/keywords/import-cerebro";

/**
 * POST /api/v1/catalog/keywords/import
 *
 * multipart/form-data:
 *   file   — a Helium 10 Cerebro reverse-ASIN .csv export (required)
 *   source — batch label stored on each row (optional; defaults to
 *            "cerebro-<today>"). Pass the SAME label when uploading the
 *            set of shape files in one session so head terms dedup.
 *
 * Writes the upload to /tmp, runs importCerebroCsv (scrub + classify +
 * upsert into catalog_keywords), deletes the tmpfile, returns stats.
 *
 * Idempotent: upsert on (phrase, source) refreshes Helium metrics and
 * preserves any manual override_status.
 */
export async function POST(req: NextRequest) {
  let tmpPath: string | null = null;
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const source = (formData.get("source") as string | null)?.trim()
      || `cerebro-${new Date().toISOString().slice(0, 10)}`;

    if (!file) {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }

    tmpPath = path.join(os.tmpdir(), `cerebro-${Date.now()}-${Math.floor(Math.random() * 1e6)}.csv`);
    fs.writeFileSync(tmpPath, Buffer.from(await file.arrayBuffer()));

    const stats = importCerebroCsv(tmpPath, { source });
    return NextResponse.json({ ok: true, fileName: file.name, stats });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  } finally {
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
    }
  }
}
