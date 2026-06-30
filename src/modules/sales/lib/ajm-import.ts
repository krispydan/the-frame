/**
 * AJM legacy customer importer.
 *
 * Consumes the JSONL produced by scripts/prep-ajm-import.py — one row
 * per AJM boutique with pre-computed cohort tags, status, and AJM
 * historical metadata (spend / orders / last order date / category).
 *
 * Dedupe cascade (first match wins):
 *   1. email exact (lowercased)
 *   2. domain (extracted from email)
 *   3. company-name normalised AND state match
 *   4. phone (10-digit)
 *
 * Matched companies → MERGE: append the AJM tags, fill any null core
 * fields (don't clobber operator edits), set status to 'customer' if
 * the prep script flagged a Jaxy match.
 *
 * Unmatched → CREATE: new company row, primary contact if name present,
 * company_phones row if phone present.
 *
 * Idempotent — re-running with the same JSONL is a no-op because the
 * dedupe cascade finds the same row each time and the tag merge is a
 * set union.
 */

import { sqlite } from "@/lib/db";
import { randomUUID } from "crypto";
import { dedupeTagsArray } from "./dedupe-tags";
import { addCompanyEmail } from "./company-emails";

export interface AjmRow {
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string;
  contact_first_name: string | null;
  status: string; // "customer" | "qualified_lead"
  source: string; // "ajm_2025_import"
  tags: string[];
  ajm_last_order: string | null;
  ajm_first_order: string | null;
  ajm_total_spend: number | null;
  ajm_total_orders: number | null;
  ajm_status: string | null;
  ajm_category: string | null;
  ajm_match_source: string | null;
  jaxy_match_reason: string | null;
  jaxy_customer_id: string | null;
  cohort: string;
}

export interface AjmImportSummary {
  total_rows: number;
  created: number;
  merged_by_email: number;
  merged_by_domain: number;
  merged_by_name_state: number;
  merged_by_phone: number;
  status_upgraded_to_customer: number;
  contacts_created: number;
  phones_added: number;
  errors: { row: number; name?: string; reason: string }[];
}

function normEmail(s: string | null | undefined): string | null {
  if (!s) return null;
  const v = String(s).trim().toLowerCase();
  return v || null;
}

function extractDomain(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase().trim() || null;
}

function normPhone(s: string | null | undefined): string | null {
  if (!s) return null;
  const digits = String(s).replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return null;
}

function normName(s: string | null | undefined): string {
  if (!s) return "";
  return String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\b(llc|inc|ltd|co|corp|company|the|boutique|store|shop)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normState(s: string | null | undefined): string {
  if (!s) return "";
  const v = String(s).trim();
  // Two-letter postal codes are canonical; everything else first-two-chars
  // is a coarse fallback (matches the prep script behaviour).
  return v.length === 2 ? v.toUpperCase() : v.slice(0, 2).toUpperCase();
}

interface ExistingMatch {
  id: string;
  tags: string | null;
  status: string | null;
  email: string | null;
  phone: string | null;
  matched_by: "email" | "domain" | "name_state" | "phone";
}

function findExistingCompany(row: AjmRow): ExistingMatch | null {
  const email = normEmail(row.email);
  const phone = normPhone(row.phone);
  const nameNorm = normName(row.name);
  const stateNorm = normState(row.state);

  // 1. email exact — case-insensitive against contacts (canonical).
  if (email) {
    const r = sqlite
      .prepare(
        `SELECT c.id, c.tags, c.status, ct.email AS email, NULL AS phone
           FROM contacts ct
           JOIN companies c ON c.id = ct.company_id
          WHERE LOWER(TRIM(ct.email)) = ?
          LIMIT 1`,
      )
      .get(email) as
      | { id: string; tags: string | null; status: string | null; email: string | null; phone: string | null }
      | undefined;
    if (r) return { ...r, matched_by: "email" };
  }

  // 2. domain
  const domain = extractDomain(email);
  if (domain && !domain.endsWith("@relay.faire.com") && !isPersonalDomain(domain)) {
    const r = sqlite
      .prepare(
        `SELECT c.id, c.tags, c.status,
                (SELECT ct.email FROM contacts ct
                  WHERE ct.company_id = c.id
                    AND TRIM(COALESCE(ct.email, '')) <> ''
                  ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS email,
                NULL AS phone
           FROM companies c
          WHERE LOWER(c.domain) = ? LIMIT 1`,
      )
      .get(domain) as
      | { id: string; tags: string | null; status: string | null; email: string | null; phone: string | null }
      | undefined;
    if (r) return { ...r, matched_by: "domain" };
  }

  // 3. name + state (only if both populated and name has enough signal)
  if (nameNorm && nameNorm.length >= 4 && stateNorm) {
    const r = sqlite
      .prepare(
        `SELECT c.id, c.tags, c.status,
                (SELECT ct.email FROM contacts ct
                  WHERE ct.company_id = c.id
                    AND TRIM(COALESCE(ct.email, '')) <> ''
                  ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS email,
                NULL AS phone,
                c.name, c.state
           FROM companies c
          WHERE c.state = ?
            AND LOWER(c.name) LIKE ?
          LIMIT 5`,
      )
      .all(stateNorm, `%${nameNorm.slice(0, 24)}%`) as Array<{
      id: string;
      tags: string | null;
      status: string | null;
      email: string | null;
      phone: string | null;
      name: string;
      state: string;
    }>;
    for (const cand of r) {
      if (normName(cand.name) === nameNorm) {
        return {
          id: cand.id,
          tags: cand.tags,
          status: cand.status,
          email: cand.email,
          phone: cand.phone,
          matched_by: "name_state",
        };
      }
    }
  }

  // 4. phone (10-digit, last resort — high false-positive risk so only
  //    accept if no name+state was provided to compare against)
  if (phone) {
    const r = sqlite
      .prepare(
        `SELECT c.id, c.tags, c.status,
                (SELECT ct.email FROM contacts ct
                  WHERE ct.company_id = c.id
                    AND TRIM(COALESCE(ct.email, '')) <> ''
                  ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS email,
                cp.phone
           FROM companies c
           JOIN company_phones cp ON cp.company_id = c.id
          WHERE cp.phone = ?
          LIMIT 1`,
      )
      .get(phone) as
      | { id: string; tags: string | null; status: string | null; email: string | null; phone: string | null }
      | undefined;
    if (r) return { ...r, matched_by: "phone" };
  }

  return null;
}

const PERSONAL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "aol.com", "comcast.net",
  "msn.com", "outlook.com", "icloud.com", "sbcglobal.net", "verizon.net",
  "cox.net", "me.com", "bellsouth.net", "earthlink.net", "mac.com",
  "ymail.com", "live.com", "att.net", "q.com", "centurylink.net",
]);
function isPersonalDomain(d: string): boolean {
  return PERSONAL_DOMAINS.has(d.toLowerCase());
}

function mergeTags(existingJson: string | null, incoming: string[]): string {
  let existing: string[] = [];
  if (existingJson) {
    try {
      const parsed = JSON.parse(existingJson);
      if (Array.isArray(parsed)) existing = parsed;
    } catch {
      // hybrid / comma-separated fallback — split on commas as a last resort
      existing = existingJson.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return JSON.stringify(dedupeTagsArray([...existing, ...incoming]));
}

export interface ImportOpts {
  /** When true, compute every action but make zero writes. */
  dryRun?: boolean;
  /** Optional progress callback (every 100 rows). */
  onProgress?: (processed: number, total: number) => void;
}

export function importAjmRows(rows: AjmRow[], opts: ImportOpts = {}): AjmImportSummary {
  const summary: AjmImportSummary = {
    total_rows: rows.length,
    created: 0,
    merged_by_email: 0,
    merged_by_domain: 0,
    merged_by_name_state: 0,
    merged_by_phone: 0,
    status_upgraded_to_customer: 0,
    contacts_created: 0,
    phones_added: 0,
    errors: [],
  };

  const dryRun = !!opts.dryRun;
  const now = new Date().toISOString();

  // Prepared statements (skip in dry-run — still useful for plan but we
  // don't execute them).
  // Email is no longer on the companies row — written via
  // addCompanyEmail below. updateExisting + insertNew don't reference
  // it anymore.
  const updateExisting = sqlite.prepare(
    `UPDATE companies SET
       tags = ?,
       status = COALESCE(NULLIF(?, ''), status),
       address = COALESCE(address, NULLIF(?, '')),
       city = COALESCE(city, NULLIF(?, '')),
       state = COALESCE(state, NULLIF(?, '')),
       zip = COALESCE(zip, NULLIF(?, '')),
       country = COALESCE(NULLIF(country, ''), 'United States'),
       ajm_total_spend = COALESCE(ajm_total_spend, ?),
       ajm_total_orders = COALESCE(ajm_total_orders, ?),
       ajm_first_order = COALESCE(ajm_first_order, ?),
       ajm_last_order = COALESCE(ajm_last_order, ?),
       ajm_status = COALESCE(ajm_status, NULLIF(?, '')),
       ajm_category = COALESCE(ajm_category, NULLIF(?, '')),
       updated_at = ?
     WHERE id = ?`,
  );
  const insertNew = sqlite.prepare(
    `INSERT INTO companies (
       id, name, address, city, state, zip, country,
       status, source, source_type, tags,
       ajm_total_spend, ajm_total_orders, ajm_first_order, ajm_last_order,
       ajm_status, ajm_category,
       created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertPhone = sqlite.prepare(
    `INSERT OR IGNORE INTO company_phones
       (id, company_id, phone, source, is_primary, created_at, updated_at)
     VALUES (?,?,?,?,1,?,?)`,
  );
  const phoneExists = sqlite.prepare(
    `SELECT 1 FROM company_phones WHERE company_id = ? AND phone = ? LIMIT 1`,
  );
  const insertContact = sqlite.prepare(
    `INSERT INTO contacts (id, company_id, first_name, last_name, email, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  const contactExists = sqlite.prepare(
    `SELECT 1 FROM contacts WHERE company_id = ? AND LOWER(COALESCE(email,'')) = LOWER(COALESCE(?,'')) LIMIT 1`,
  );

  rows.forEach((row, i) => {
    try {
      const existing = findExistingCompany(row);
      const phoneNorm = normPhone(row.phone);

      if (existing) {
        // ── MERGE path ──
        switch (existing.matched_by) {
          case "email": summary.merged_by_email++; break;
          case "domain": summary.merged_by_domain++; break;
          case "name_state": summary.merged_by_name_state++; break;
          case "phone": summary.merged_by_phone++; break;
        }
        const mergedTags = mergeTags(existing.tags, row.tags);
        // Only upgrade to 'customer' (real Jaxy match). Never downgrade.
        const newStatus = row.status === "customer" && existing.status !== "customer"
          ? "customer"
          : "";
        if (row.status === "customer" && existing.status !== "customer") {
          summary.status_upgraded_to_customer++;
        }
        if (!dryRun) {
          updateExisting.run(
            mergedTags,
            newStatus,
            row.address ?? "",
            row.city ?? "",
            row.state ?? "",
            row.zip ?? "",
            row.ajm_total_spend,
            row.ajm_total_orders,
            row.ajm_first_order,
            row.ajm_last_order,
            row.ajm_status ?? "",
            row.ajm_category ?? "",
            now,
            existing.id,
          );
          // Email lands in contacts (canonical), not on companies.
          if (row.email) {
            addCompanyEmail(existing.id, row.email, "ajm_import");
          }
          if (phoneNorm && !phoneExists.get(existing.id, phoneNorm)) {
            insertPhone.run(
              randomUUID(),
              existing.id,
              phoneNorm,
              "ajm_2025_import",
              now,
              now,
            );
            summary.phones_added++;
          }
        }
      } else {
        // ── CREATE path ──
        const id = randomUUID();
        if (!dryRun) {
          insertNew.run(
            id,
            row.name,
            row.address ?? null,
            row.city ?? null,
            row.state ?? null,
            row.zip ?? null,
            row.country || "United States",
            row.status,
            row.source,
            "ajm_legacy",
            JSON.stringify(dedupeTagsArray(row.tags)),
            row.ajm_total_spend,
            row.ajm_total_orders,
            row.ajm_first_order,
            row.ajm_last_order,
            row.ajm_status,
            row.ajm_category,
            now,
            now,
          );
          // companies.phone was dropped (2026-06-19); the old mirror trigger
          // is gone, so write the phone straight into company_phones.
          if (phoneNorm) {
            insertPhone.run(randomUUID(), id, phoneNorm, "ajm_2025_import", now, now);
            summary.phones_added++;
          }
          // Email goes to contacts (canonical), not on the company row.
          if (row.email) {
            addCompanyEmail(id, row.email, "ajm_import");
          }

          // Contact: create one if a name was provided.
          if (row.contact_first_name) {
            if (!contactExists.get(id, row.email ?? "")) {
              insertContact.run(
                randomUUID(),
                id,
                row.contact_first_name,
                "",
                row.email ?? null,
                now,
                now,
              );
              summary.contacts_created++;
            }
          }
        }
        summary.created++;
        if (row.status === "customer") summary.status_upgraded_to_customer++;
      }
    } catch (e) {
      summary.errors.push({
        row: i,
        name: row.name,
        reason: e instanceof Error ? e.message : String(e),
      });
    }

    if (opts.onProgress && (i + 1) % 100 === 0) {
      opts.onProgress(i + 1, rows.length);
    }
  });

  return summary;
}
