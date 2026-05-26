/**
 * Parse Amazon's SUNGLASSES category upload template into a JSON snapshot
 * the application can read at runtime — and emit a stripped XLSX copy of
 * the workbook for the writer to clone.
 *
 * Why a snapshot: the template has 313 columns, enum lists for ~100 of
 * them, and length rules buried in free-text. Hardcoding any of it in
 * TypeScript means stale code the next time Amazon updates the template.
 * The snapshot is the source of truth — re-run this script when the
 * template changes (Amazon ships a new version periodically) and the
 * column-mapper + validator follow automatically.
 *
 * Usage:
 *   npx tsx scripts/snapshot-amazon-template.ts [path-to-xlsm]
 *
 * Defaults to ~/Downloads/SUNGLASSES.xlsm (where Daniel saved it).
 * Outputs:
 *   src/modules/catalog/lib/amazon/template-snapshot.json
 *   public/amazon-template.xlsx                   (macros stripped, sheets preserved)
 */
import * as XLSX from "xlsx";
import * as fs from "fs";
import * as path from "path";

// ── Snapshot shape ────────────────────────────────────────────────────────

interface ColumnDef {
  /** Internal attribute name from Template row 3 (e.g. "item_sku"). */
  name: string;
  /** Human label from Template row 2 (e.g. "Seller SKU"). Display only. */
  label: string;
  /** Position in the Template sheet, 0-indexed. Stable column order. */
  index: number;
  /** True when Data Definitions marks this field "Required". */
  required: boolean;
  /** Group section header from Data Definitions ("Basic", "Variation", …). */
  group: string | null;
  /** Free-form definition text from Data Definitions, trimmed. */
  definition: string | null;
  /** Sample value Amazon provides in Data Definitions. */
  example: string | null;
  /** Max character length parsed out of the "Accepted Values" text if mentioned. */
  maxLength: number | null;
  /** Permitted values when the field is an enum. Drawn from Dropdown Lists.
   *  When absent, the field is free-text / numeric / URL. */
  enumValues: string[] | null;
}

interface TemplateSnapshot {
  source: {
    path: string;
    templateType: string | null;
    version: string | null;
    signature: string | null;
    snapshotTakenAt: string;
  };
  /** Row index where data starts in the Template sheet (0-indexed → 3). */
  dataRowIndex: number;
  /** Ordered list of every column in the Template sheet. */
  columns: ColumnDef[];
}

// ── Helpers ───────────────────────────────────────────────────────────────

function cellText(ws: XLSX.WorkSheet, r: number, c: number): string | null {
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell = ws[addr];
  if (!cell || cell.v == null) return null;
  return String(cell.v).trim() || null;
}

function getSheetDims(ws: XLSX.WorkSheet): { rows: number; cols: number } {
  if (!ws["!ref"]) return { rows: 0, cols: 0 };
  const r = XLSX.utils.decode_range(ws["!ref"]);
  return { rows: r.e.r + 1, cols: r.e.c + 1 };
}

/**
 * Pick the max char-length out of free text like:
 *   "An alphanumeric string; max 200 characters."
 *   "Maximum 500 characters; bullet point text only."
 *   "Up to 40 chars."
 * Returns null if no length hint found.
 */
function parseMaxLength(text: string | null): number | null {
  if (!text) return null;
  const patterns = [
    /max(?:imum)?\s+(\d{1,5})\s*(?:char(?:acter)?s?)/i,
    /up\s+to\s+(\d{1,5})\s*(?:char(?:acter)?s?)/i,
    /(\d{1,5})\s*(?:char(?:acter)?s?)\s*(?:max(?:imum)?|or\s+less|or\s+fewer)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0 && n <= 10000) return n;
    }
  }
  return null;
}

// ── Sheet parsers ─────────────────────────────────────────────────────────

/**
 * Template sheet → ordered list of (internal name, human label) per column.
 * Row 1 = settings metadata. Row 2 (r=1) = labels. Row 3 (r=2) = internal
 * attribute names. Row 4+ (r=3+) = data.
 */
function parseTemplateHeader(ws: XLSX.WorkSheet): {
  labels: Array<{ name: string; label: string }>;
  meta: { templateType: string | null; version: string | null; signature: string | null };
} {
  const { cols } = getSheetDims(ws);
  const labels: Array<{ name: string; label: string }> = [];

  for (let c = 0; c < cols; c++) {
    const internal = cellText(ws, 2, c);
    if (!internal) continue;
    const label = cellText(ws, 1, c) ?? internal;
    labels.push({ name: internal, label });
  }

  // Row 1 metadata is encoded as "Key=Value" strings spread across cells.
  const metaParts: Record<string, string> = {};
  for (let c = 0; c < cols; c++) {
    const v = cellText(ws, 0, c);
    if (!v) continue;
    const m = v.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m) metaParts[m[1]] = m[2];
  }

  return {
    labels,
    meta: {
      templateType: metaParts.TemplateType ?? null,
      version: metaParts.Version ?? null,
      signature: metaParts.TemplateSignature ?? null,
    },
  };
}

/**
 * Data Definitions sheet → per-field { required, definition, example,
 * acceptedValuesText, group }.
 *
 * Layout: row 0 = title. Row 1 = headers
 *   col A = Group Name, B = Field Name, C = Local Label Name,
 *   D = Definition and Use, E = Accepted Values, F = Example, G = Required?
 *
 * "Group" rows have a value in col A and the rest blank — we remember the
 * last seen group and stamp it on subsequent field rows until the next
 * group header.
 */
interface DataDef {
  required: boolean;
  group: string | null;
  definition: string | null;
  acceptedValuesText: string | null;
  example: string | null;
}

function parseDataDefinitions(ws: XLSX.WorkSheet): Map<string, DataDef> {
  const out = new Map<string, DataDef>();
  const { rows } = getSheetDims(ws);
  let currentGroup: string | null = null;

  for (let r = 2; r < rows; r++) {
    const groupCell = cellText(ws, r, 0);
    const fieldName = cellText(ws, r, 1);
    // Pure group banner row: col A populated, col B empty.
    if (groupCell && !fieldName) {
      // Strip the long "These are attributes that…" suffix Amazon often appends.
      currentGroup = groupCell.replace(/\s*-\s+These are.*$/i, "").trim();
      continue;
    }
    if (!fieldName) continue;

    const definition = cellText(ws, r, 3);
    const acceptedValuesText = cellText(ws, r, 4);
    const example = cellText(ws, r, 5);
    const requiredRaw = cellText(ws, r, 6);
    const required = !!requiredRaw && /required/i.test(requiredRaw);

    out.set(fieldName, {
      required,
      group: currentGroup,
      definition,
      acceptedValuesText,
      example,
    });
  }
  return out;
}

/**
 * Dropdown Lists sheet → map of attribute name → string[] of valid values.
 *
 * Layout: row 0 (r=0) is blank, row 1 (r=1) is the product-type label
 * ("sunglasses") repeated per column, row 2 (r=2) is the internal attribute
 * name, row 3+ are values stacked vertically until a blank cell.
 *
 * Note: when a column has only a single value (e.g. feed_product_type =
 * sunglasses), we still record it as a one-item enum — the validator
 * treats single-value enums as a hard constraint, which is exactly right.
 */
function parseDropdownLists(ws: XLSX.WorkSheet): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const { rows, cols } = getSheetDims(ws);

  for (let c = 0; c < cols; c++) {
    const attr = cellText(ws, 2, c);
    if (!attr) continue;
    const values: string[] = [];
    for (let r = 3; r < rows; r++) {
      const v = cellText(ws, r, c);
      if (!v) break; // Dropdown columns are contiguous — stop at first blank.
      values.push(v);
    }
    if (values.length > 0) {
      // De-dupe while preserving order (case-sensitive — Amazon validates literal).
      const seen = new Set<string>();
      const deduped: string[] = [];
      for (const v of values) {
        if (seen.has(v)) continue;
        seen.add(v);
        deduped.push(v);
      }
      out.set(attr, deduped);
    }
  }
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────

function main() {
  const inputPath = process.argv[2] || path.join(process.env.HOME ?? "", "Downloads/SUNGLASSES.xlsm");
  if (!fs.existsSync(inputPath)) {
    console.error(`Template not found: ${inputPath}`);
    process.exit(1);
  }
  // template-snapshot.json lives next to its TypeScript consumers (so
  // Next bundles it via the JSON import). template.xlsx lives in
  // public/ so it's reliably on disk at runtime — Next.js only ships
  // static assets that are inside .next or public/ when standalone
  // output is disabled.
  const outDir = path.join(process.cwd(), "src/modules/catalog/lib/amazon");
  fs.mkdirSync(outDir, { recursive: true });
  const snapshotPath = path.join(outDir, "template-snapshot.json");
  const publicDir = path.join(process.cwd(), "public");
  fs.mkdirSync(publicDir, { recursive: true });
  const xlsxOutPath = path.join(publicDir, "amazon-template.xlsx");

  console.log(`Reading ${inputPath} ...`);
  const wb = XLSX.readFile(inputPath, { bookVBA: false });

  const templateWs = wb.Sheets["Template"];
  if (!templateWs) {
    console.error("Template sheet not found");
    process.exit(1);
  }
  const dataDefsWs = wb.Sheets["Data Definitions"];
  const dropdownWs = wb.Sheets["Dropdown Lists"];

  const { labels, meta } = parseTemplateHeader(templateWs);
  const dataDefs = dataDefsWs ? parseDataDefinitions(dataDefsWs) : new Map<string, DataDef>();
  const dropdowns = dropdownWs ? parseDropdownLists(dropdownWs) : new Map<string, string[]>();

  const columns: ColumnDef[] = labels.map(({ name, label }, index) => {
    const dd = dataDefs.get(name);
    const enumValues = dropdowns.get(name) ?? null;
    return {
      name,
      label,
      index,
      required: dd?.required ?? false,
      group: dd?.group ?? null,
      definition: dd?.definition ?? null,
      example: dd?.example ?? null,
      maxLength: parseMaxLength(dd?.acceptedValuesText ?? null),
      enumValues,
    };
  });

  const snapshot: TemplateSnapshot = {
    source: {
      path: path.basename(inputPath),
      templateType: meta.templateType,
      version: meta.version,
      signature: meta.signature,
      snapshotTakenAt: new Date().toISOString(),
    },
    dataRowIndex: 3,
    columns,
  };

  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  console.log(`  ✓ Snapshot → ${path.relative(process.cwd(), snapshotPath)}`);

  // Write a stripped XLSX clone (no macros) for the writer to use as the
  // shell. Reading the .xlsm at runtime would require xlsx's full-feature
  // build; reading a plain .xlsx is faster and the writer doesn't need
  // VBA. All sheets are preserved so Amazon's dropdowns + Data Definitions
  // sheet still show up for ops to reference if they open the output.
  XLSX.writeFile(wb, xlsxOutPath, { bookType: "xlsx", bookSST: false });
  console.log(`  ✓ Stripped XLSX → ${path.relative(process.cwd(), xlsxOutPath)}`);

  // Summary so the operator can sanity-check the snapshot at a glance.
  const required = columns.filter((c) => c.required).length;
  const enumed = columns.filter((c) => c.enumValues && c.enumValues.length > 0).length;
  const lengthed = columns.filter((c) => c.maxLength != null).length;
  console.log();
  console.log("Summary:");
  console.log(`  Template version : ${meta.version ?? "(none)"}`);
  console.log(`  Total columns    : ${columns.length}`);
  console.log(`  Required         : ${required}`);
  console.log(`  Enum-validated   : ${enumed}`);
  console.log(`  Length-bounded   : ${lengthed}`);

  // Show a quick peek so we can verify enums match the docs.
  for (const key of ["lens_color_map", "frame_material_type", "polarization_type", "target_gender", "age_range_description"]) {
    const col = columns.find((c) => c.name === key);
    if (col?.enumValues) {
      console.log(`  ${key}: ${col.enumValues.slice(0, 8).join(", ")}${col.enumValues.length > 8 ? `, … (${col.enumValues.length} total)` : ""}`);
    } else {
      console.log(`  ${key}: (no enum found)`);
    }
  }
}

main();
