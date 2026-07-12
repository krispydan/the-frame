/**
 * Pure parser for the AJ Morgan Faire brand-portal customer export (CSV, no DB
 * deps, so it's unit-testable in isolation). The DB-backed analysis (frame
 * matching, Jaxy exclusion, value split) lives in faire-marketplace-import.ts.
 *
 * This is the full Faire "Customers" export — ~17k rows, most of which are
 * never-ordered email leads. Only rows that have ACTUALLY ordered (Faire
 * Activity = "Has ordered", or a positive Order Amount / Order Count) are the
 * reactivation target; the parser flags each row's `ordered` so the analysis
 * can drop the pure leads.
 */

export interface FaireRow {
  email: string | null;
  storeName: string | null;
  storeType: string | null;
  contact: string | null;
  spend: number; // Order Amount, dollars
  orderCount: number;
  lastOrdered: string | null; // raw ISO, e.g. "2023-10-04" (or "NA")
  lastOrderedTs: number | null; // parsed epoch ms, null if NA/blank/unparseable
  firstOrdered: string | null;
  address1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  customTags: string | null;
  faireActivity: string | null; // "Has ordered" | "Never ordered"
  ordered: boolean; // derived: has this store ever placed an order?
}

function money(v: string | null | undefined): number {
  const n = parseFloat(String(v ?? "").replace(/[$,\s]/g, ""));
  return isNaN(n) ? 0 : n;
}

function naStr(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return !s || s.toUpperCase() === "NA" ? null : s;
}

function parseTs(v: string | null | undefined): number | null {
  const s = naStr(v);
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.getTime();
}

/** RFC4180-ish CSV parser: handles quotes, escaped quotes, embedded commas/newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Parse the Faire customer export CSV. Header-driven (column names, not
 * positions). Skips rows with neither a store name nor an email. Every returned
 * row carries `ordered` so the caller can keep only real customers.
 */
export function parseFaireExport(text: string): { rows: FaireRow[]; skipped: number } {
  const grid = parseCsv(text);
  if (grid.length < 2) return { rows: [], skipped: 0 };

  const header = grid[0].map((h) => h.trim());
  const col = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const idx = {
    email: col("Email Address"),
    store: col("Store Name"),
    storeType: col("Store Type"),
    contact: col("Contact Name"),
    amt: col("Order Amount"),
    cnt: col("Order Count"),
    last: col("Last Ordered"),
    first: col("First Ordered"),
    address1: col("Address 1"),
    city: col("City"),
    state: col("State"),
    zip: col("Zip Code"),
    tags: col("Custom Tags"),
    activity: col("Faire Activity"),
  };
  const get = (r: string[], i: number) => (i >= 0 && i < r.length ? r[i] : "");

  const rows: FaireRow[] = [];
  let skipped = 0;
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    if (!r || r.length < 3) {
      skipped++;
      continue;
    }
    const store = naStr(get(r, idx.store));
    const emailRaw = (get(r, idx.email) || "").trim().toLowerCase();
    const email = emailRaw && emailRaw.includes("@") ? emailRaw : null;
    // Drop rows with no way to identify the store at all (and the TOTAL footer).
    if ((!store && !email) || (store && store.toUpperCase() === "TOTAL")) {
      skipped++;
      continue;
    }
    const spend = money(get(r, idx.amt));
    const orderCount = parseInt(get(r, idx.cnt) || "0", 10) || 0;
    const activity = naStr(get(r, idx.activity));
    const ordered = activity === "Has ordered" || spend > 0 || orderCount > 0;

    rows.push({
      email,
      storeName: store,
      storeType: naStr(get(r, idx.storeType)),
      contact: naStr(get(r, idx.contact)),
      spend,
      orderCount,
      lastOrdered: naStr(get(r, idx.last)),
      lastOrderedTs: parseTs(get(r, idx.last)),
      firstOrdered: naStr(get(r, idx.first)),
      address1: naStr(get(r, idx.address1)),
      city: naStr(get(r, idx.city)),
      state: naStr(get(r, idx.state)),
      zip: naStr(get(r, idx.zip)),
      customTags: naStr(get(r, idx.tags)),
      faireActivity: activity,
      ordered,
    });
  }
  return { rows, skipped };
}
