/**
 * ShipHero Product Bulk Edit CSV.
 *
 * Creates new Inner Pack (12-pack) product records. Each SKUs sync from Shopify;
 * only Inner Packs need creating via this CSV.
 *
 * Format: UTF-8, comma-delimited, standard quoting, LF line endings.
 * Required column: SKU. Headers are case-sensitive.
 */

import { buildCsvFromRecords } from "./csv-utils";

const HEADERS = ["SKU", "Name", "Barcode", "Warehouse", "Weight"] as const;

export const SHIPHERO_WAREHOUSE = "BSF - Las Vegas / BSF - Las Vegas";
export const DEFAULT_INNER_PACK_WEIGHT_LBS = 1.5;
export const ROW_LIMIT = 800;

export type ProductBulkEditInput = {
  /** Each SKU, e.g. JX1001-BLK */
  eachSku: string;
  /** Product name, e.g. Monroe */
  productName: string;
  /** Color name, e.g. Black */
  colorName: string;
  /** Inner Pack SKU, e.g. JX1001-BLK-12PK */
  innerPackSku: string | null;
  /** Inner Pack UPC (14-digit GS1), e.g. 10605547877435 */
  innerPackUpc: string | null;
  /** Inner Pack weight in pounds. Null uses DEFAULT_INNER_PACK_WEIGHT_LBS. */
  weightLbs?: number | null;
};

export type ProductBulkEditWarnings = {
  skippedNoInnerPackSku: string[];
  skippedNoUpc: string[];
  emitted: number;
};

/**
 * Build one or more ShipHero Product Bulk Edit CSVs.
 *
 * @returns `{ csvs, warnings }` where csvs is one file per 800-row chunk.
 */
export function buildProductBulkEditCsv(
  inputs: ProductBulkEditInput[],
  opts: { rowLimit?: number } = {}
): { csvs: string[]; warnings: ProductBulkEditWarnings } {
  const rowLimit = opts.rowLimit ?? ROW_LIMIT;

  const skippedNoInnerPackSku: string[] = [];
  const skippedNoUpc: string[] = [];
  const rows: Record<(typeof HEADERS)[number], string | number>[] = [];

  for (const input of inputs) {
    if (!input.innerPackSku) {
      skippedNoInnerPackSku.push(input.eachSku);
      continue;
    }
    if (!input.innerPackUpc) {
      skippedNoUpc.push(input.innerPackSku);
      continue;
    }
    rows.push({
      SKU: input.innerPackSku,
      Name: `${input.productName} - ${input.colorName} (12-pack)`,
      Barcode: input.innerPackUpc,
      Warehouse: SHIPHERO_WAREHOUSE,
      Weight: input.weightLbs ?? DEFAULT_INNER_PACK_WEIGHT_LBS,
    });
  }

  const csvs: string[] = [];
  for (let i = 0; i < rows.length; i += rowLimit) {
    const chunk = rows.slice(i, i + rowLimit);
    csvs.push(buildCsvFromRecords(HEADERS, chunk));
  }
  // Always return at least one file (an empty one if there are no rows).
  if (csvs.length === 0) csvs.push(buildCsvFromRecords(HEADERS, []));

  return {
    csvs,
    warnings: {
      skippedNoInnerPackSku,
      skippedNoUpc,
      emitted: rows.length,
    },
  };
}
