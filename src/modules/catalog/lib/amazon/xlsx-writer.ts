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
  // Don't use XLSX.readFile() — the xlsx library lazily resolves `fs`
  // via a dynamic require, which Next.js's bundler strips, leading to
  // a confusing "Cannot access file <path>" error in production even
  // when the file is right there on disk. Reading the bytes with Node
  // fs and passing them to XLSX.read() sidesteps the bundler issue
  // entirely — no dynamic require, just a Buffer the library can parse
  // straight away.
  const buf = fs.readFileSync(TEMPLATE_PATH);
  const wb = XLSX.read(buf, { type: "buffer", cellStyles: false });
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

/**
 * Emit the listing in the tab-delimited TXT format Amazon Seller Central
 * accepts. The .xlsx path was rejected with FATAL error 90503 ("uploaded
 * file was saved in a format that could not be read") because their
 * processor expects either the unmodified .xlsm template (with macros
 * intact, which xlsx-js can't round-trip) or a tab-delimited .txt.
 * TSV removes every format/macro/compression edge case from the loop —
 * Amazon's docs even spell this out in the 90503 error message
 * ("...in a tab-delimited format or an Excel format").
 *
 * Output structure mirrors the Template sheet's first 3 header rows
 * exactly (metadata, display labels, internal attribute names) so
 * Amazon's parser can identify the template version and the column
 * order, followed by the data rows in snapshot column order.
 *
 * Cells with embedded tabs/newlines/quotes are passed through with the
 * problem characters stripped — Amazon's TSV parser is line/tab-based
 * and doesn't support escaping. In practice the only field at risk is
 * product_description (free-form text); we replace newlines with " "
 * and tabs with " " up front. Same defensive handling Amazon's own
 * inventory file documentation suggests.
 */
export function buildAmazonTsvBuffer(rows: Record<string, string>[]): Buffer {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(
      `Template file missing: ${TEMPLATE_PATH}. Run \`npx tsx scripts/snapshot-amazon-template.ts\` first.`,
    );
  }
  const buf = fs.readFileSync(TEMPLATE_PATH);
  const wb = XLSX.read(buf, { type: "buffer", cellStyles: false });
  const ws = wb.Sheets["Template"];
  if (!ws) throw new Error("Template sheet missing from amazon-template.xlsx");

  // Read the first 3 header rows verbatim out of the template so we keep
  // Amazon's TemplateType / TemplateSignature / display labels / internal
  // attribute names exactly as they expect them.
  const cols = getAmazonColumns();
  const headerMatrix = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    range: 0,
    blankrows: false,
    defval: "",
  }) as unknown[][];

  const headerRows = headerMatrix.slice(0, 3).map((row) =>
    cols.map((_, i) => sanitiseCell(row[i])),
  );

  // Build data rows in snapshot column order — same shape as the xlsx
  // path, just emitted as strings.
  const dataMatrix = rows.map((row) =>
    cols.map((c) => sanitiseCell(row[c.name] ?? "")),
  );

  // Amazon uses \r\n on inventory files. Use \r\n to match their spec
  // and avoid line-ending guessing on their side.
  const lines = [...headerRows, ...dataMatrix].map((cells) => cells.join("\t"));
  const body = lines.join("\r\n") + "\r\n";
  return Buffer.from(body, "utf-8");
}

/** TSV cells can't carry tab / newline / CR — replace them with a single
 *  space rather than escape, since Amazon's parser doesn't support
 *  RFC-4180 quoting on inventory files. */
function sanitiseCell(value: unknown): string {
  if (value == null) return "";
  return String(value).replace(/[\t\r\n]+/g, " ").trim();
}
