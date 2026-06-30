/**
 * AJM wholesale CSV → cleaned AjmRow[].
 *
 * Parses the AJM customer export (comma- or tab-delimited) and cleans each row
 * for import via importAjmRows():
 *   - Company / ATTN / ADDRESS / ADDRESS2 / CITY → Title Case (source is ALL CAPS)
 *   - emails → whitespace stripped, validated, junk dropped (URLs, LLM error text)
 *   - website pulled from the Website column or a domain that landed in an email field
 *   - zip leading-zero restored, phone reduced to digits, state upper-cased
 *   - "Dont send postcard to reason" → status/cohort (mirror of prep-ajm-import.py)
 *
 * Columns expected (header names, case-sensitive):
 *   Company, LT_SLS_DT, Dont send postcard to reason, PHONE, CUS_ID,
 *   email_1, email_2, Website, ATTN, ADDRESS, ADDRESS2, CITY, STATE, ZIP, COUNTRY
 */

import type { AjmRow } from "./ajm-import";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// Tokens that should stay upper-case after title-casing.
const KEEP_UPPER = new Set(["LLC", "LLP", "INC", "USA", "US", "PO", "BBQ", "II", "III", "IV", "DC", "NYC", "LA", "MD", "PA"]);

function norm(s: string | null | undefined): string {
  return (s ?? "").trim();
}

export function titleCase(s: string | null | undefined): string | null {
  const v = norm(s);
  if (!v) return null;
  let out = v
    .toLowerCase()
    .replace(/(^|[\s\-/&.()'’,#])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
  // Re-uppercase known acronyms (LLC, INC, USA, …).
  out = out.replace(/\b([A-Za-z]{2,4})\b/g, (t) => (KEEP_UPPER.has(t.toUpperCase()) ? t.toUpperCase() : t));
  return out;
}

export function cleanEmail(v: string | null | undefined): string | null {
  const e = norm(v).replace(/\s+/g, "").toLowerCase();
  if (!e || e.length > 120) return null;
  return EMAIL_RE.test(e) ? e : null;
}

/** A value that looks like a website/domain (not an email, no spaces). */
function urlish(v: string | null | undefined): boolean {
  const s = norm(v);
  if (!s || /\s/.test(s) || s.includes("@")) return false;
  return /^https?:\/\//i.test(s) || /^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(s);
}

function cleanWebsite(v: string | null | undefined): string | null {
  const s = norm(v);
  if (!urlish(s)) return null;
  return s.replace(/\/+$/, "");
}

function digits(v: string | null | undefined): string | null {
  const d = norm(v).replace(/\D/g, "");
  return d || null;
}

function padZip(v: string | null | undefined): string | null {
  const s = norm(v);
  if (!s) return null;
  if (/^\d{4}$/.test(s)) return "0" + s; // CT/NH/etc lost a leading zero in export
  return s;
}

/** Mirror of prep-ajm-import.py classify(): reason → (bucket, status, cohort). */
export function classify(reason: string): { bucket: string; status: string | null; cohort: string | null } {
  const r = reason.trim().toLowerCase().replace(/[\s.\-_|]+/g, " ").trim();
  if (!r) return { bucket: "reactivation", status: "qualified_lead", cohort: "ajm_reactivation" };
  if (/duplicate|out of business|business closed|store closed|non us/.test(r)) {
    return { bucket: "skip", status: null, cohort: null };
  }
  if (r.startsWith("email is invalid")) {
    return { bucket: "invalid_email", status: "qualified_lead", cohort: "ajm_reactivation" };
  }
  if (/jaxy|already order|already purchas|already bought|this location already|just purchased|just ordered|ordered jaxy/.test(r)) {
    return { bucket: "customer", status: "customer", cohort: "ajm_already_customer" };
  }
  return { bucket: "reactivation", status: "qualified_lead", cohort: "ajm_reactivation" };
}

// ── delimited parsing (RFC4180-ish; handles quotes; comma or tab) ────────────

function parseDelimited(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delim = firstLine.includes("\t") ? "\t" : ",";
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
    } else if (c === delim) {
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

export interface AjmCsvStats {
  totalRows: number;
  emitted: number;
  customer: number;
  reactivation: number;
  invalidEmail: number;
  skippedClosed: number;
  skippedNoName: number;
  withEmail: number;
  withWebsite: number;
}

/**
 * Parse + clean the AJM CSV text into importable AjmRow[] plus a summary.
 * Header row is required.
 */
export function buildAjmRowsFromCsv(
  text: string,
  opts: { pushTag?: boolean } = {},
): { rows: AjmRow[]; stats: AjmCsvStats } {
  // This CSV is the curated wholesale list we want in Pipedrive, so tag rows
  // with `ajm_pipedrive_push` (what the Pipedrive AJM seed selects on) unless
  // explicitly told not to.
  const pushTag = opts.pushTag !== false;
  const grid = parseDelimited(text);
  const stats: AjmCsvStats = {
    totalRows: 0, emitted: 0, customer: 0, reactivation: 0, invalidEmail: 0,
    skippedClosed: 0, skippedNoName: 0, withEmail: 0, withWebsite: 0,
  };
  if (grid.length < 2) return { rows: [], stats };

  const header = grid[0].map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const col = {
    company: idx("Company"),
    reason: idx("Dont send postcard to reason"),
    phone: idx("PHONE"),
    cusId: idx("CUS_ID"),
    email1: idx("email_1"),
    email2: idx("email_2"),
    website: idx("Website"),
    attn: idx("ATTN"),
    address: idx("ADDRESS"),
    address2: idx("ADDRESS2"),
    city: idx("CITY"),
    state: idx("STATE"),
    zip: idx("ZIP"),
    country: idx("COUNTRY"),
    lastSale: idx("LT_SLS_DT"),
  };
  const get = (r: string[], i: number) => (i >= 0 && i < r.length ? r[i] : "");

  const rows: AjmRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    if (r.length === 1 && norm(r[0]) === "") continue; // blank line
    stats.totalRows++;

    const reason = norm(get(r, col.reason));
    const { bucket, status, cohort } = classify(reason);
    if (bucket === "skip") {
      stats.skippedClosed++;
      continue;
    }
    const name = titleCase(get(r, col.company));
    if (!name) {
      stats.skippedNoName++;
      continue;
    }

    let email = cleanEmail(get(r, col.email1)) || cleanEmail(get(r, col.email2));
    if (bucket === "invalid_email") email = null; // call-only

    // Website: explicit column, else a domain that landed in an email field.
    const website =
      cleanWebsite(get(r, col.website)) ||
      cleanWebsite(get(r, col.email2)) ||
      cleanWebsite(get(r, col.email1));

    const addr = titleCase(get(r, col.address));
    const addr2 = titleCase(get(r, col.address2));
    const address = [addr, addr2].filter(Boolean).join(", ") || null;

    rows.push({
      name,
      email,
      phone: digits(get(r, col.phone)),
      website,
      address,
      address2: null, // folded into address (companies has no address2 column)
      city: titleCase(get(r, col.city)),
      state: norm(get(r, col.state)).toUpperCase() || null,
      zip: padZip(get(r, col.zip)),
      country: norm(get(r, col.country)) || "US",
      contact_first_name: titleCase(get(r, col.attn)),
      status: status as string,
      source: "ajm_2025_import",
      tags: pushTag ? ["ajm_2025", cohort as string, "ajm_pipedrive_push"] : ["ajm_2025", cohort as string],
      ajm_last_order: norm(get(r, col.lastSale)) || null,
      ajm_first_order: null,
      ajm_total_spend: null,
      ajm_total_orders: null,
      ajm_status: null,
      ajm_category: null,
      ajm_match_source: null,
      jaxy_match_reason: bucket === "customer" ? reason : null,
      jaxy_customer_id: norm(get(r, col.cusId)) || null,
      cohort: cohort as string,
    });

    stats.emitted++;
    if (bucket === "customer") stats.customer++;
    else if (bucket === "invalid_email") stats.invalidEmail++;
    else stats.reactivation++;
    if (email) stats.withEmail++;
    if (website) stats.withWebsite++;
  }

  return { rows, stats };
}
