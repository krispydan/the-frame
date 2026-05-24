export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * POST /api/v1/catalog/skus/import-upcs
 *
 * Bulk-import UPC / barcode codes onto catalog_skus from a ShipHero
 * "Products → Export" CSV. The CSV has 42 columns; we only care about
 * the SKU column (col 2) and the Barcode column (col 11). The endpoint
 * parses the CSV header to find them by name rather than position so a
 * future ShipHero schema change doesn't silently break the import.
 *
 * Body: { "csv": "<full CSV text>", "dryRun": true|false }
 *
 * Response shape:
 *   {
 *     ok,
 *     dryRun,
 *     totalRows, matched, unmatched, alreadySet, willUpdate, errors,
 *     lengthDistribution: { 9: 34, 12: 86, 14: 115, ... },
 *     samples: [{ sku, upc, length, action }],   // first 30
 *     unmatchedSkus: ["…"]                       // first 30
 *   }
 *
 * Safety:
 *   - Only writes when (current upc IS NULL OR current upc !== new upc).
 *     Re-runs are idempotent.
 *   - Skips rows where barcode is empty / 1-char so junk doesn't land.
 *   - Wraps writes in a single transaction so a parse error in the
 *     middle leaves the DB untouched.
 */
export async function POST(req: NextRequest) {
  let body: { csv?: string; dryRun?: boolean } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.csv || typeof body.csv !== "string") {
    return NextResponse.json({ ok: false, error: "csv field is required" }, { status: 400 });
  }
  const dryRun = !!body.dryRun;

  const { rows, errors: parseErrors } = parseCsv(body.csv);
  if (rows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No rows parsed from CSV", parseErrors },
      { status: 400 },
    );
  }

  const header = rows[0];
  const skuIdx = findHeaderIndex(header, ["sku"]);
  const barcodeIdx = findHeaderIndex(header, ["barcode", "upc"]);
  if (skuIdx < 0 || barcodeIdx < 0) {
    return NextResponse.json(
      { ok: false, error: "Header must contain SKU and Barcode columns", header },
      { status: 400 },
    );
  }

  const dataRows = rows.slice(1);

  // Index local SKUs so the per-row lookup is O(1).
  const localRows = sqlite
    .prepare("SELECT id, sku, upc FROM catalog_skus")
    .all() as Array<{ id: string; sku: string | null; upc: string | null }>;
  const bySkU = new Map<string, { id: string; upc: string | null }>();
  for (const r of localRows) {
    if (r.sku) bySkU.set(r.sku.trim(), { id: r.id, upc: r.upc });
  }

  type Action = "unchanged" | "would_update" | "updated" | "no_local_match" | "blank_barcode";
  const lengthDistribution: Record<number, number> = {};
  const samples: Array<{ sku: string; upc: string; length: number; action: Action; current?: string | null }> = [];
  const unmatchedSkus: string[] = [];

  let matched = 0;
  let unmatched = 0;
  let alreadySet = 0;
  let willUpdate = 0;
  let blankBarcode = 0;

  const updateStmt = sqlite.prepare(
    "UPDATE catalog_skus SET upc = ?, updated_at = datetime('now') WHERE id = ?",
  );

  const apply = sqlite.transaction((updates: Array<{ id: string; upc: string }>) => {
    for (const u of updates) updateStmt.run(u.upc, u.id);
  });

  const pendingUpdates: Array<{ id: string; upc: string }> = [];

  for (const dataRow of dataRows) {
    const sku = (dataRow[skuIdx] ?? "").trim();
    const barcode = (dataRow[barcodeIdx] ?? "").trim();

    if (!sku) continue;

    if (!barcode || barcode.length < 6) {
      blankBarcode++;
      if (samples.length < 30) samples.push({ sku, upc: barcode, length: barcode.length, action: "blank_barcode" });
      continue;
    }
    lengthDistribution[barcode.length] = (lengthDistribution[barcode.length] ?? 0) + 1;

    const local = bySkU.get(sku);
    if (!local) {
      unmatched++;
      if (unmatchedSkus.length < 30) unmatchedSkus.push(sku);
      if (samples.length < 30) samples.push({ sku, upc: barcode, length: barcode.length, action: "no_local_match" });
      continue;
    }
    matched++;

    if (local.upc === barcode) {
      alreadySet++;
      if (samples.length < 30) samples.push({ sku, upc: barcode, length: barcode.length, action: "unchanged", current: local.upc });
      continue;
    }

    willUpdate++;
    if (samples.length < 30) {
      samples.push({
        sku, upc: barcode, length: barcode.length,
        action: dryRun ? "would_update" : "updated",
        current: local.upc,
      });
    }
    pendingUpdates.push({ id: local.id, upc: barcode });
  }

  if (!dryRun && pendingUpdates.length > 0) {
    apply(pendingUpdates);
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    totalRows: dataRows.length,
    matched,
    unmatched,
    alreadySet,
    willUpdate,
    blankBarcode,
    lengthDistribution,
    samples,
    unmatchedSkus,
    parseErrors,
  });
}

// ── Tiny CSV parser (RFC 4180-ish: quoted fields, escaped quotes) ───────

interface ParseResult {
  rows: string[][];
  errors: string[];
}

function parseCsv(text: string): ParseResult {
  const rows: string[][] = [];
  const errors: string[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++; // skip escape
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      // End of row — but only on \n; ignore \r (handles \r\n).
      if (ch === "\r" && next === "\n") continue;
      row.push(field);
      // Skip blank trailing lines
      if (row.length > 1 || (row.length === 1 && row[0].trim() !== "")) {
        rows.push(row);
      }
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }
  // Flush last field/row if no trailing newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.length > 1 || (row.length === 1 && row[0].trim() !== "")) {
      rows.push(row);
    }
  }
  return { rows, errors };
}

function findHeaderIndex(header: string[], candidates: string[]): number {
  const norm = header.map((h) => h.trim().toLowerCase());
  for (const c of candidates) {
    const idx = norm.indexOf(c.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}
