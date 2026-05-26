/**
 * Compose the final Amazon-ready XLSX. Clones the stripped template
 * shipped at public/amazon-template.xlsx, writes data rows onto the
 * "Template" sheet starting at the snapshot's dataRowIndex (row 4,
 * 0-indexed = 3), and leaves all other sheets (Instructions / Data
 * Definitions / Valid Values / Dropdown Lists / Example / Images /
 * AttributePTDMAP / Browse Data / Conditions List) untouched so Amazon's
 * dropdown validations and ops-facing references survive into Seller
 * Central.
 *
 * Why public/ and not src/? Next.js doesn't bundle arbitrary binary
 * assets that aren't .js/.ts imports, and `output: "standalone"` is
 * disabled in this app so outputFileTracingIncludes is a no-op. The
 * public/ directory is the one location guaranteed to land on disk at
 * runtime via `next start`. The file is the public Amazon template,
 * so there's no concern about it being addressable at
 * /amazon-template.xlsx.
 *
 * Returns a Node Buffer the route handler can stream as
 * application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.
 */
import * as XLSX from "xlsx";
import * as fs from "fs";
import * as path from "path";
import { getAmazonColumns, getDataRowIndex } from "./template-snapshot";

const TEMPLATE_PATH = path.join(process.cwd(), "public", "amazon-template.xlsx");

/**
 * Build the workbook in memory. Each input row is a sparse
 * Record<attr,string> (mapper output); we materialise it into a 2D
 * array ordered by the snapshot's column order, so the spreadsheet
 * always matches Amazon's column positions exactly.
 */
export function buildAmazonWorkbook(rows: Record<string, string>[]): XLSX.WorkBook {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(
      `Template file missing: ${TEMPLATE_PATH}. Run \`npx tsx scripts/snapshot-amazon-template.ts\` first.`,
    );
  }
  const wb = XLSX.readFile(TEMPLATE_PATH, { cellStyles: false });
  const ws = wb.Sheets["Template"];
  if (!ws) throw new Error("Template sheet missing from template.xlsx");

  const cols = getAmazonColumns();
  const dataRow = getDataRowIndex();

  // Convert sparse row dicts → ordered 2D array.
  const matrix: string[][] = rows.map((row) =>
    cols.map((c) => {
      const v = row[c.name];
      return v == null ? "" : String(v);
    }),
  );

  if (matrix.length > 0) {
    // origin = data row in Amazon-template coords (row 4, A column).
    XLSX.utils.sheet_add_aoa(ws, matrix, {
      origin: { r: dataRow, c: 0 },
    });

    // Recompute !ref so the new rows are inside the sheet's bounding box.
    const lastCol = cols.length - 1;
    const lastRow = dataRow + matrix.length - 1;
    ws["!ref"] = XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: lastRow, c: lastCol },
    });
  }

  return wb;
}

/** Serialise the workbook to a Node Buffer (.xlsx). */
export function serializeWorkbook(wb: XLSX.WorkBook): Buffer {
  // bookSST=false: shared-string table off keeps file size lean and
  // matches how the template ships.
  const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx", bookSST: false });
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

/** Convenience: compose + serialise in one call. */
export function buildAmazonXlsxBuffer(rows: Record<string, string>[]): Buffer {
  return serializeWorkbook(buildAmazonWorkbook(rows));
}
