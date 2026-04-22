/**
 * ShipHero UOM Mapping CSV.
 *
 * Defines the relationship: 1 unit of {each_sku}-12PK contains 12 units of {each_sku}.
 *
 * Format (STRICT — deviations cause upload failures):
 *   - UTF-8, comma-delimited
 *   - CRLF line endings (\r\n)
 *   - QUOTE_ALL (every field wrapped in double quotes)
 *   - Headers verbatim: "UOM SKU","Component SKU","Component QTY","UoM type"
 *   - UoM type values: exactly "Inner Pack", "Master Case", or "Pallet"
 */

import { buildCsvFromRecords } from "./csv-utils";

const HEADERS = ["UOM SKU", "Component SKU", "Component QTY", "UoM type"] as const;

export const ROW_LIMIT = 800;

export type UomInput = {
  /** Each SKU, e.g. JX1001-BLK */
  eachSku: string;
  /** Inner Pack SKU, e.g. JX1001-BLK-12PK */
  innerPackSku: string | null;
  /** Number of eaches per inner pack. Default 12 if omitted. */
  innerPackQty?: number | null;
};

export type UomWarnings = {
  skippedNoInnerPackSku: string[];
  skippedBadQty: string[];
  deduped: string[];
  emitted: number;
};

/**
 * Build one or more ShipHero UOM Mapping CSVs.
 *
 * @returns `{ csvs, warnings }` — csvs is one file per 800-row chunk.
 */
export function buildUomMappingCsv(
  inputs: UomInput[],
  opts: { rowLimit?: number } = {}
): { csvs: string[]; warnings: UomWarnings } {
  const rowLimit = opts.rowLimit ?? ROW_LIMIT;

  const skippedNoInnerPackSku: string[] = [];
  const skippedBadQty: string[] = [];
  const deduped: string[] = [];
  const seen = new Set<string>();
  const rows: Record<(typeof HEADERS)[number], string | number>[] = [];

  for (const input of inputs) {
    if (!input.innerPackSku) {
      skippedNoInnerPackSku.push(input.eachSku);
      continue;
    }
    const qty = input.innerPackQty ?? 12;
    if (!Number.isFinite(qty) || qty <= 0) {
      skippedBadQty.push(input.innerPackSku);
      continue;
    }
    if (seen.has(input.innerPackSku)) {
      deduped.push(input.innerPackSku);
      continue;
    }
    seen.add(input.innerPackSku);
    rows.push({
      "UOM SKU": input.innerPackSku,
      "Component SKU": input.eachSku,
      "Component QTY": qty,
      "UoM type": "Inner Pack",
    });
  }

  const csvs: string[] = [];
  for (let i = 0; i < rows.length; i += rowLimit) {
    const chunk = rows.slice(i, i + rowLimit);
    csvs.push(buildCsvFromRecords(HEADERS, chunk, { lineEnding: "\r\n", quoting: "all" }));
  }
  if (csvs.length === 0) {
    csvs.push(buildCsvFromRecords(HEADERS, [], { lineEnding: "\r\n", quoting: "all" }));
  }

  return {
    csvs,
    warnings: {
      skippedNoInnerPackSku,
      skippedBadQty,
      deduped,
      emitted: rows.length,
    },
  };
}
