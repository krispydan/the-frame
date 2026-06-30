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

/**
 * In-memory dedupe index. `contacts` has no indexes and `company_phones.phone`
 * isn't independently indexed, so the old per-row email/phone/name-LIKE lookups
 * were full scans — O(rows × table), which timed out on the full cohort. We
 * build these maps once (a few full scans) and then match in O(1) per row.
 * "First write wins" mirrors the old `LIMIT 1` queries.
 */
interface DedupeIndex {
  byId: Map<string, { tags: string | null; status: string | null }>;
  email: Map<string, string>;     // normEmail -> companyId
  domain: Map<string, string>;    // domain -> companyId
  nameState: Map<string, string>; // `${state}|${nameNorm}` -> companyId
  phone: Map<string, string>;     // 10-digit -> companyId
}

function buildDedupeIndex(): DedupeIndex {
  const idx: DedupeIndex = {
    byId: new Map(),
    email: new Map(),
    domain: new Map(),
    nameState: new Map(),
    phone: new Map(),
  };
  const comps = sqlite
    .prepare("SELECT id, name, state, domain, tags, status FROM companies")
    .all() as Array<{ id: string; name: string | null; state: string | null; domain: string | null; tags: string | null; status: string | null }>;
  for (const c of comps) {
    idx.byId.set(c.id, { tags: c.tags, status: c.status });
    if (c.domain) {
      const d = c.domain.toLowerCase().trim();
      if (d && !idx.domain.has(d)) idx.domain.set(d, c.id);
    }
    const n = normName(c.name);
    const s = normState(c.state);
    if (n.length >= 4 && s) {
      const k = `${s}|${n}`;
      if (!idx.nameState.has(k)) idx.nameState.set(k, c.id);
    }
  }
  const cts = sqlite
    .prepare("SELECT company_id, email FROM contacts WHERE email IS NOT NULL AND TRIM(email) <> ''")
    .all() as Array<{ company_id: string; email: string }>;
  for (const ct of cts) {
    const e = normEmail(ct.email);
    if (e && !idx.email.has(e)) idx.email.set(e, ct.company_id);
  }
  const phs = sqlite
    .prepare("SELECT company_id, phone FROM company_phones")
    .all() as Array<{ company_id: string; phone: string }>;
  for (const p of phs) {
    const ph = normPhone(p.phone);
    if (ph && !idx.phone.has(ph)) idx.phone.set(ph, p.company_id);
  }
  return idx;
}

function findExistingCompany(row: AjmRow, idx: DedupeIndex): ExistingMatch | null {
  const email = normEmail(row.email);
  const phone = normPhone(row.phone);
  const nameNorm = normName(row.name);
  const stateNorm = normState(row.state);
  const meta = (id: string) => idx.byId.get(id) ?? { tags: null, status: null };

  // 1. email exact (canonical home is contacts)
  if (email) {
    const id = idx.email.get(email);
    if (id) return { id, ...meta(id), email, phone: null, matched_by: "email" };
  }
  // 2. business domain (skip personal / Faire relay)
  const domain = extractDomain(email);
  if (domain && !domain.endsWith("@relay.faire.com") && !isPersonalDomain(domain)) {
    const id = idx.domain.get(domain);
    if (id) return { id, ...meta(id), email: null, phone: null, matched_by: "domain" };
  }
  // 3. name + state (exact normalised)
  if (nameNorm && nameNorm.length >= 4 && stateNorm) {
    const id = idx.nameState.get(`${stateNorm}|${nameNorm}`);
    if (id) return { id, ...meta(id), email: null, phone: null, matched_by: "name_state" };
  }
  // 4. phone (10-digit, last resort)
  if (phone) {
    const id = idx.phone.get(phone);
    if (id) return { id, ...meta(id), email: null, phone, matched_by: "phone" };
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

export interface TagPushSummary {
  total_rows: number;
  matched: number;
  tagged: number;
  already_tagged: number;
  unmatched: number;
  matched_by: { email: number; domain: number; name_state: number; phone: number };
  sample_unmatched: string[];
  dryRun: boolean;
}

/**
 * Add a tag (default `ajm_pipedrive_push`) to existing frame companies that
 * match the given rows, using the *same* dedupe matcher the AJM import used —
 * so every row that was imported resolves to its company. Idempotent: a
 * company that already carries the tag is counted but not rewritten, and
 * multiple rows resolving to one company tag it once.
 *
 * Used to mark the curated wholesale subset (Sheet7) for the Pipedrive seed.
 */
export function tagAjmPushRows(
  rows: Array<{ name?: string | null; email?: string | null; phone?: string | null; state?: string | null }>,
  tag = "ajm_pipedrive_push",
  opts: { dryRun?: boolean } = {},
): TagPushSummary {
  const dryRun = !!opts.dryRun;
  const now = new Date().toISOString();
  const idx = buildDedupeIndex();
  const update = sqlite.prepare("UPDATE companies SET tags = ?, updated_at = ? WHERE id = ?");

  const summary: TagPushSummary = {
    total_rows: rows.length,
    matched: 0,
    tagged: 0,
    already_tagged: 0,
    unmatched: 0,
    matched_by: { email: 0, domain: 0, name_state: 0, phone: 0 },
    sample_unmatched: [],
    dryRun,
  };
  const handled = new Set<string>(); // company ids already processed this run

  for (const r of rows) {
    const probe = { name: r.name || "", email: r.email ?? null, phone: r.phone ?? null, state: r.state ?? null };
    const match = findExistingCompany(probe as AjmRow, idx);
    if (!match) {
      summary.unmatched++;
      if (summary.sample_unmatched.length < 25) summary.sample_unmatched.push(r.name || r.email || r.phone || "?");
      continue;
    }
    summary.matched++;
    summary.matched_by[match.matched_by]++;
    if (handled.has(match.id)) continue;
    handled.add(match.id);

    const current = idx.byId.get(match.id)?.tags ?? match.tags;
    let hasTag = false;
    if (current) {
      try {
        const arr = JSON.parse(current);
        hasTag = Array.isArray(arr) && arr.some((t) => String(t).toLowerCase() === tag.toLowerCase());
      } catch {
        hasTag = current.toLowerCase().includes(tag.toLowerCase());
      }
    }
    if (hasTag) {
      summary.already_tagged++;
      continue;
    }
    const merged = mergeTags(current, [tag]);
    if (!dryRun) update.run(merged, now, match.id);
    const meta = idx.byId.get(match.id);
    if (meta) meta.tags = merged; // keep index live for later rows
    summary.tagged++;
  }
  return summary;
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

  // Build the dedupe index once (O(table)) so per-row matching is O(1). Kept
  // updated below as rows are created/merged so later rows in the same run
  // still dedupe against earlier ones — matching the old live-query behaviour.
  const idx = buildDedupeIndex();

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
      const existing = findExistingCompany(row, idx);
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
          // keep the in-memory index in step with these writes
          const me = normEmail(row.email);
          if (me && !idx.email.has(me)) idx.email.set(me, existing.id);
          if (phoneNorm && !idx.phone.has(phoneNorm)) idx.phone.set(phoneNorm, existing.id);
          idx.byId.set(existing.id, { tags: mergedTags, status: newStatus || existing.status });
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
          // register the new company so later rows this run dedupe against it
          idx.byId.set(id, { tags: JSON.stringify(dedupeTagsArray(row.tags)), status: row.status });
          const nn = normName(row.name);
          const ss = normState(row.state);
          if (nn.length >= 4 && ss) idx.nameState.set(`${ss}|${nn}`, id);
          const ne = normEmail(row.email);
          if (ne && !idx.email.has(ne)) idx.email.set(ne, id);
          if (phoneNorm && !idx.phone.has(phoneNorm)) idx.phone.set(phoneNorm, id);
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
