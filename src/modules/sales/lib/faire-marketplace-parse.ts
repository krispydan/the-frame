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

/** Normalize a store name to a match key (lowercase, drop punctuation + common
 *  suffix/filler words) so an overlay email can be matched to an export row. */
export function normStoreKey(s: string | null | undefined): string {
  if (!s) return "";
  return String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(llc|inc|ltd|co|corp|company|the|boutique|store|shop|shoppe)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a supplementary "emails found" overlay (the manually looked-up list):
 * any TSV/CSV that has a Store Name column and an email column (e.g. "Email
 * Found" / "Email"). Returns normStoreKey(store) → email. Tolerant of tab or
 * comma delimiters and header naming.
 */
export function parseEmailOverlay(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return map;
  const delim = lines[0].includes("\t") ? "\t" : ",";
  const cells = (line: string) =>
    delim === "\t" ? line.split("\t").map((c) => c.trim()) : parseCsv(line)[0]?.map((c) => c.trim()) ?? [];
  const header = cells(lines[0]).map((h) => h.toLowerCase());
  const storeCol = header.findIndex((h) => h.includes("store"));
  const emailCol = header.findIndex((h) => h.includes("email"));
  if (storeCol < 0 || emailCol < 0) return map;
  for (let i = 1; i < lines.length; i++) {
    const r = cells(lines[i]);
    const store = normStoreKey(r[storeCol]);
    const email = (r[emailCol] || "").trim().toLowerCase();
    if (store && email.includes("@") && !map.has(store)) map.set(store, email);
  }
  return map;
}

/** One Instantly lead row (upload columns). */
export interface InstantlyLead {
  email: string;
  firstName: string;
  lastName: string;
  companyName: string;
  city: string;
  state: string;
  lastOrdered: string;
  lifetimeSpend: string;
  tier: string; // "high" | "low"
}

const INSTANTLY_HEADERS = [
  "email",
  "first_name",
  "last_name",
  "company_name",
  "city",
  "state",
  "last_ordered",
  "lifetime_spend",
  "tier",
];

function csvCell(v: string | null | undefined): string {
  const s = (v ?? "").toString();
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Format Instantly leads into an upload-ready CSV (CRLF, quoted as needed). */
export function formatInstantlyCsv(leads: InstantlyLead[]): string {
  const lines = [INSTANTLY_HEADERS.join(",")];
  for (const l of leads) {
    lines.push(
      [l.email, l.firstName, l.lastName, l.companyName, l.city, l.state, l.lastOrdered, l.lifetimeSpend, l.tier]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n");
}

/** Proper-case a name so mail merge reads "Hi Daniel", not "Hi DANIEL" / "Hi
 *  daniel". Handles apostrophes and hyphens (O'Brien, Anne-Marie). */
export function properCase(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/(^|[\s'’.-])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
    .trim();
}

// Contact-field tokens that mean it's a role/business, not a person.
const NON_PERSON_TOKENS = new Set([
  "buyer", "accounts", "account", "payable", "owner", "manager", "info", "sales", "admin",
  "team", "staff", "support", "service", "customer", "purchasing", "store", "shop", "boutique",
]);

/**
 * The first name to use for the {{firstName}} merge — proper-cased, or "" when
 * the contact clearly isn't a person (so Instantly's fallback kicks in rather
 * than "Hi ZERBO'S"). Blanks on: empty / email-in-field / non-alphabetic first
 * token / a role word anywhere / a business suffix / an ALL-CAPS contact that
 * echoes the store name.
 */
export function firstNameForMerge(contact: string | null | undefined, storeName?: string | null): string {
  const c = (contact ?? "").trim();
  if (!c || c.includes("@")) return "";
  const tokens = c.split(/\s+/).filter(Boolean);
  const firstRaw = tokens[0];
  if (!/^[A-Za-z][A-Za-z'’.-]*$/.test(firstRaw)) return "";
  if (tokens.some((t) => NON_PERSON_TOKENS.has(t.toLowerCase()))) return "";
  if (/\b(llc|inc|ltd|corp|co|company)\b/i.test(c)) return "";
  // ALL-CAPS contact that is a subset of the store name → it's the business.
  const isAllCaps = c === c.toUpperCase() && c !== c.toLowerCase();
  if (isAllCaps && storeName) {
    const ck = normStoreKey(c);
    const sk = normStoreKey(storeName);
    if (ck && sk && sk.includes(ck)) return "";
  }
  return properCase(firstRaw);
}

/** Split a contact name into a proper-cased first/last (first token vs rest). */
export function splitName(name: string | null | undefined): { firstName: string; lastName: string } {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: "", lastName: "" };
  return { firstName: properCase(parts[0]), lastName: properCase(parts.slice(1).join(" ")) };
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
