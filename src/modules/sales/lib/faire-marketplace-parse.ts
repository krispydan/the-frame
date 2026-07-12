/**
 * Pure parser for the AJ Morgan Faire customer export (no DB deps, so it's
 * unit-testable in isolation). The DB-backed analysis (frame matching, Jaxy
 * exclusion, value split) lives in faire-marketplace-import.ts.
 */

export interface FaireRow {
  storeName: string;
  contact: string | null;
  email: string | null; // Email, else "Email from AI"
  spend: number; // Order Volume, dollars
  totalOrders: number | null;
  lastOrdered: string | null; // raw, e.g. "Nov 28, 2025"
  lastOrderedTs: number | null; // parsed epoch ms, null if unparseable/blank
  storeType: string | null;
}

function money(v: string | null | undefined): number {
  if (!v) return 0;
  const n = parseFloat(v.replace(/[$,\s]/g, ""));
  return isNaN(n) ? 0 : n;
}

function parseDate(v: string | null | undefined): number | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.getTime();
}

/** Split one TSV line, trimming each cell. */
function splitTsv(line: string): string[] {
  return line.split("\t").map((c) => c.trim());
}

/**
 * Parse the pasted/exported TSV. Header-driven (column names, not positions) so
 * trailing padding columns and reordering don't break it. Skips the TOTAL
 * footer row and rows with no usable store name.
 */
export function parseFaireExport(text: string): { rows: FaireRow[]; skipped: number } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { rows: [], skipped: 0 };

  const header = splitTsv(lines[0]);
  const col = (name: string) =>
    header.findIndex((h) => h.toLowerCase().replace(/\s+/g, " ").trim() === name.toLowerCase());
  const idx = {
    store: col("Store Name"),
    contact: col("Contact"),
    email: col("Email"),
    emailAi: col("Email from AI"),
    volume: col("Order Volume"),
    orders: col("Total Orders"),
    last: col("Last Ordered"),
    type: col("Store Type"),
  };
  const get = (r: string[], i: number) => (i >= 0 && i < r.length ? r[i] : "");

  const rows: FaireRow[] = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const r = splitTsv(lines[i]);
    const storeName = get(r, idx.store).trim();
    // Drop the footer TOTAL row and blank / name-less rows.
    if (!storeName || storeName.toUpperCase() === "TOTAL") {
      skipped++;
      continue;
    }
    const emailPrimary = get(r, idx.email).trim();
    const emailAi = get(r, idx.emailAi).trim();
    const email = emailPrimary || emailAi || null;
    const last = get(r, idx.last).trim() || null;
    rows.push({
      storeName,
      contact: get(r, idx.contact).trim() || null,
      email: email && email.includes("@") ? email.toLowerCase() : null,
      spend: money(get(r, idx.volume)),
      totalOrders: idx.orders >= 0 ? parseInt(get(r, idx.orders) || "0", 10) || 0 : null,
      lastOrdered: last,
      lastOrderedTs: parseDate(last),
      storeType: get(r, idx.type).trim() || null,
    });
  }
  return { rows, skipped };
}
