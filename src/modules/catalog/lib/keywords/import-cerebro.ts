/**
 * Import a Helium 10 Cerebro reverse-ASIN keyword export into
 * catalog_keywords. Each phrase is run through classifyKeyword (scrub.ts)
 * before it lands, so brand/irrelevant/off-intent rows are filtered or
 * flagged at import time — the assembler downstream only ever sees clean
 * data.
 *
 * Idempotent: upsert on (phrase, source). Re-importing the same file
 * refreshes the Helium metrics but PRESERVES any manual override_status
 * set from the review UI. We dedup head terms across the 7 shape files
 * by passing the SAME `source` for a whole import run — the first file's
 * row wins, later identical phrases just refresh metrics.
 *
 * We persist only the "interesting" verdicts (keep / brand / irrelevant)
 * so the review UI can show what was scrubbed; off_intent + junk are
 * counted but not stored (they'd be ~70% of every file and add no value).
 */
import fs from "fs";
import Papa from "papaparse";
import { sqlite } from "@/lib/db";
import { classifyKeyword, type KeywordVerdict, type ClassifyOptions } from "./scrub";

/** Raw Cerebro CSV row — only the columns we consume are typed. */
interface CerebroRow {
  "Keyword Phrase"?: string;
  "Search Volume"?: string;
  "Title Density"?: string;
  "Competing Products"?: string;
  "Keyword Sales"?: string;
  "Cerebro IQ Score"?: string;
}

export interface CerebroImportStats {
  source: string;
  fileName: string;
  totalRows: number;
  stored: number;
  byVerdict: Record<KeywordVerdict, number>;
  /** Stored keeps broken down by canonical shape (null → "head"). */
  keepByShape: Record<string, number>;
  durationMs: number;
}

/** Verdicts worth persisting — keeps feed the assembler, brand/irrelevant
 *  give the review UI an audit trail of what we threw away. */
const STORE_VERDICTS: ReadonlySet<KeywordVerdict> = new Set(["keep", "brand", "irrelevant"]);

/** Parse a Helium numeric cell: "-" / "" → 0, strip thousands commas. */
function num(v: string | undefined): number {
  if (!v) return 0;
  const cleaned = v.replace(/,/g, "").trim();
  if (!cleaned || cleaned === "-") return 0;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export interface ImportCerebroOptions extends ClassifyOptions {
  /** Batch label stored on every row, e.g. "cerebro-2026-06-09". Pass the
   *  same value across all files in one run so head terms dedup. */
  source: string;
}

export function importCerebroCsv(
  filePath: string,
  opts: ImportCerebroOptions,
): CerebroImportStats {
  const start = Date.now();
  let csv = fs.readFileSync(filePath, "utf-8");
  // Strip UTF-8 BOM — Helium prepends one, which otherwise corrupts the
  // first header name ("﻿Keyword Phrase").
  if (csv.charCodeAt(0) === 0xfeff) csv = csv.slice(1);

  const { data } = Papa.parse<CerebroRow>(csv, {
    header: true,
    skipEmptyLines: true,
  });

  const byVerdict: Record<KeywordVerdict, number> = {
    keep: 0, brand: 0, irrelevant: 0, off_intent: 0, junk: 0,
  };
  const keepByShape: Record<string, number> = {};

  const upsert = sqlite.prepare(`
    INSERT INTO catalog_keywords (
      id, phrase, search_volume, title_density, competing_products,
      keyword_sales, cerebro_iq, classification, shape, verdict, source, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(phrase, source) DO UPDATE SET
      search_volume      = excluded.search_volume,
      title_density      = excluded.title_density,
      competing_products = excluded.competing_products,
      keyword_sales      = excluded.keyword_sales,
      cerebro_iq         = excluded.cerebro_iq,
      classification     = excluded.classification,
      shape              = excluded.shape,
      verdict            = excluded.verdict,
      imported_at        = datetime('now')
    -- override_status intentionally NOT touched: manual review wins.
  `);

  let stored = 0;
  const run = sqlite.transaction((rows: CerebroRow[]) => {
    for (const row of rows) {
      const phrase = row["Keyword Phrase"];
      if (!phrase) continue;
      const c = classifyKeyword(phrase, opts);
      byVerdict[c.verdict] += 1;
      if (c.verdict === "keep") {
        const bucket = c.shape ?? "head";
        keepByShape[bucket] = (keepByShape[bucket] ?? 0) + 1;
      }
      if (!STORE_VERDICTS.has(c.verdict)) continue;

      upsert.run(
        crypto.randomUUID(),
        c.phrase,
        num(row["Search Volume"]),
        num(row["Title Density"]),
        num(row["Competing Products"]),
        num(row["Keyword Sales"]),
        num(row["Cerebro IQ Score"]),
        c.pool,
        c.shape,
        c.verdict,
        opts.source,
      );
      stored += 1;
    }
  });
  run(data);

  return {
    source: opts.source,
    fileName: filePath.split("/").pop() ?? filePath,
    totalRows: data.length,
    stored,
    byVerdict,
    keepByShape,
    durationMs: Date.now() - start,
  };
}
