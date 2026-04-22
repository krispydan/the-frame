/**
 * Factory SKU Sheet CSV.
 *
 * Sent to factories for onboarding new styles or running a new production
 * batch. Read by humans at a Chinese factory (often non-English first
 * language). Prioritize readability over strict format compliance.
 *
 * Format:
 *   - UTF-8 WITH BOM (helps Excel on Windows render Chinese correctly)
 *   - Comma-delimited
 *   - Standard quoting, except barcodes are always quoted to preserve
 *     leading zeros when opened in Excel.
 *   - LF line endings
 *   - Headers in plain English
 */

import { buildCsv, todayCompact } from "../shiphero/csv-utils";

const HEADERS = [
  "Style",
  "Color",
  "Individual SKU",
  "Individual Barcode",
  "12-Pack SKU",
  "12-Pack Barcode",
] as const;

export type FactorySkuRow = {
  productName: string;
  colorName: string;
  eachSku: string;
  eachUpc: string | null;
  innerPackSku: string | null;
  innerPackUpc: string | null;
};

export type FactorySheetWarnings = {
  missingEachUpc: string[];
  missingInnerPackUpc: string[];
  missingInnerPackSku: string[];
  emitted: number;
};

/**
 * Quote barcode values explicitly so Excel doesn't strip leading zeros when
 * the file is opened.  We quote everything via quoteAlways for barcode cells
 * and use standard quoting elsewhere by hand.
 */
function quoteAll(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteIfNeeded(value: string): string {
  if (!value) return "";
  if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function buildFactorySkuSheetCsv(rows: FactorySkuRow[]): { csv: string; warnings: FactorySheetWarnings } {
  const warnings: FactorySheetWarnings = {
    missingEachUpc: [],
    missingInnerPackUpc: [],
    missingInnerPackSku: [],
    emitted: 0,
  };

  const headerLine = HEADERS.map(quoteIfNeeded).join(",");
  const lines: string[] = [headerLine];

  for (const r of rows) {
    if (!r.eachUpc) warnings.missingEachUpc.push(r.eachSku);
    if (!r.innerPackSku) warnings.missingInnerPackSku.push(r.eachSku);
    if (!r.innerPackUpc) warnings.missingInnerPackUpc.push(r.innerPackSku ?? r.eachSku);

    lines.push([
      quoteIfNeeded(r.productName ?? ""),
      quoteIfNeeded(r.colorName ?? ""),
      quoteIfNeeded(r.eachSku ?? ""),
      r.eachUpc ? quoteAll(r.eachUpc) : "",
      quoteIfNeeded(r.innerPackSku ?? ""),
      r.innerPackUpc ? quoteAll(r.innerPackUpc) : "",
    ].join(","));
    warnings.emitted += 1;
  }

  // UTF-8 BOM prefix, LF line endings
  const csv = "\uFEFF" + lines.join("\n") + "\n";
  return { csv, warnings };
}

/** Generate filename: jaxy_skus_{factory_code}_{YYYYMMDD}.csv */
export function factorySkuSheetFilename(factoryCode: string): string {
  return `jaxy_skus_${factoryCode}_${todayCompact()}.csv`;
}

// Re-export unused helper for symmetry with other modules
export { buildCsv };
