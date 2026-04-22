/**
 * CSV formatting primitives.
 *
 * ShipHero is strict about CSV format — different exports require different
 * quoting and line-ending rules. Keep these building blocks small and pure.
 */

/** Quote a single field only when it contains a comma, quote, or newline. */
export function quoteIfNeeded(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Always quote a field (QUOTE_ALL style). */
export function quoteAlways(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export type CsvOptions = {
  /** "\n" (LF, default) or "\r\n" (CRLF for ShipHero UOM). */
  lineEnding?: string;
  /** "minimal" (default) or "all" (QUOTE_ALL for ShipHero UOM). */
  quoting?: "minimal" | "all";
  /** Prepend UTF-8 BOM (for factory sheets opened in Excel on Windows). */
  bom?: boolean;
};

/** Render a 2D array of values as CSV text. Values are stringified via String(). */
export function buildCsv(rows: (string | number | null | undefined)[][], opts: CsvOptions = {}): string {
  const lineEnding = opts.lineEnding ?? "\n";
  const quote = opts.quoting === "all" ? quoteAlways : quoteIfNeeded;
  const body = rows
    .map((row) => row.map((cell) => quote(cell == null ? "" : String(cell))).join(","))
    .join(lineEnding);
  const text = body + lineEnding;
  return opts.bom ? "\uFEFF" + text : text;
}

/** Shorthand for records → CSV (headers are the keys in their given order). */
export function buildCsvFromRecords<K extends string>(
  headers: readonly K[],
  records: Record<K, string | number | null | undefined>[],
  opts: CsvOptions = {}
): string {
  const rows: (string | number | null | undefined)[][] = [headers as unknown as string[]];
  for (const r of records) {
    rows.push(headers.map((h) => r[h]));
  }
  return buildCsv(rows, opts);
}

export function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayCompact(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}
