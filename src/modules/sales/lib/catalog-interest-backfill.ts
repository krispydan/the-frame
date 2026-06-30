/**
 * Catalog-interest backfill from a pasted PhoneBurner follow-up list.
 *
 * Each line is an owner email (sometimes a NEW email given on the call to send
 * the catalog) + a first name. For each email we:
 *   - match it to a frame company: exact contact email → business email domain
 *     (companies.domain / website / a contact sharing the domain)
 *   - add the email to the company's contacts if we don't already have it
 *   - mark the company `interested`
 *   - push to Pipedrive (Catalog Interested, or AJM "To Contact" for AJM
 *     contacts) and put the catalog email on the Pipedrive person
 *
 * Free-provider emails that aren't an exact contact match can't be matched by
 * domain (gmail ≠ a store) — reported as unmatched for manual handling. Runs in
 * the background (many Pipedrive calls); progress is polled via settings.
 */

import crypto from "crypto";
import { sqlite } from "@/lib/db";
import { addCompanyEmail } from "./company-emails";
import { progressCompanyStatus } from "./status-progression";
import { ensureOutreachDeal } from "./pipedrive-sync";
import { pdRequest, getPipedriveConnectionStatus } from "./pipedrive-client";
import { getPipelineConfig } from "./pipedrive-setup";

const EMAIL_RE = /[^\s,;<>()]+@[^\s,;<>()]+\.[^\s,;<>()]+/;
const FREE_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yaho.com", "hotmail.com", "outlook.com",
  "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com", "comcast.net",
  "verizon.net", "att.net", "sbcglobal.net", "bellsouth.net", "cox.net", "charter.net",
  "earthlink.net", "ymail.com", "proton.me", "protonmail.com",
]);

export interface CatalogRow {
  email: string;
  name: string | null;
}

/** Parse the pasted list — one email (+ optional name) per line; skip headers/non-email lines. */
export function parseCatalogList(text: string): CatalogRow[] {
  const out: CatalogRow[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^interested in follow/i.test(t)) continue;
    const m = EMAIL_RE.exec(t);
    if (!m) continue;
    const email = m[0].toLowerCase().replace(/\s+/g, "");
    if (seen.has(email)) continue;
    seen.add(email);
    const name = t.replace(m[0], "").replace(/[\t]+/g, " ").trim() || null;
    out.push({ email, name });
  }
  return out;
}

interface Match {
  companyId: string;
  companyName: string | null;
  haveEmail: boolean;
  matchedBy: "email" | "domain";
  source: string | null;
  tags: string | null;
}

function matchCompany(email: string): Match | null {
  const e = email.toLowerCase().trim();
  const exact = sqlite
    .prepare(
      `SELECT c.id, c.name, c.source, c.tags FROM contacts ct JOIN companies c ON c.id = ct.company_id
        WHERE LOWER(TRIM(ct.email)) = ? LIMIT 1`,
    )
    .get(e) as { id: string; name: string | null; source: string | null; tags: string | null } | undefined;
  if (exact) return { companyId: exact.id, companyName: exact.name, haveEmail: true, matchedBy: "email", source: exact.source, tags: exact.tags };

  const domain = e.split("@")[1] || "";
  if (!domain || FREE_DOMAINS.has(domain)) return null;

  // a contact sharing the domain
  const byContact = sqlite
    .prepare(
      `SELECT c.id, c.name, c.source, c.tags FROM contacts ct JOIN companies c ON c.id = ct.company_id
        WHERE LOWER(ct.email) LIKE ? LIMIT 1`,
    )
    .get(`%@${domain}`) as { id: string; name: string | null; source: string | null; tags: string | null } | undefined;
  if (byContact) return { companyId: byContact.id, companyName: byContact.name, haveEmail: false, matchedBy: "domain", source: byContact.source, tags: byContact.tags };

  // companies.domain or website containing the domain
  const byCompany = sqlite
    .prepare(
      `SELECT id, name, source, tags FROM companies
        WHERE LOWER(COALESCE(domain,'')) = ? OR LOWER(COALESCE(website,'')) LIKE ? LIMIT 1`,
    )
    .get(domain, `%${domain}%`) as { id: string; name: string | null; source: string | null; tags: string | null } | undefined;
  if (byCompany) return { companyId: byCompany.id, companyName: byCompany.name, haveEmail: false, matchedBy: "domain", source: byCompany.source, tags: byCompany.tags };

  return null;
}

function isAjm(m: Match): boolean {
  if (m.source === "ajm_2025_import") return true;
  return typeof m.tags === "string" && m.tags.toLowerCase().includes("ajm_2025");
}

/** Append an email to a Pipedrive person (best-effort, dedup against existing). */
async function putPersonEmail(personId: number, email: string): Promise<void> {
  try {
    const person = await pdRequest<{ email?: Array<{ value?: string } | string> }>("GET", `/persons/${personId}`);
    const existing = (person?.email || [])
      .map((x) => (typeof x === "string" ? x : x?.value || ""))
      .filter(Boolean)
      .map((s) => s.toLowerCase());
    if (existing.includes(email.toLowerCase())) return;
    await pdRequest("PUT", `/persons/${personId}`, { email: [...existing, email] });
  } catch {
    /* best-effort */
  }
}

export interface CatalogBackfillResult {
  total: number;
  matched: number;
  created: number;
  emailAdded: number;
  alreadyHadEmail: number;
  pushed: number;
  unmatched: number;
  unmatchedSamples: string[];
  dryRun: boolean;
}

/** Add email (if new) + mark interested + push to Pipedrive for one company. */
async function processCompany(
  companyId: string,
  email: string,
  ajm: boolean,
  haveEmail: boolean,
  canPush: boolean,
  result: CatalogBackfillResult,
): Promise<void> {
  if (!haveEmail) addCompanyEmail(companyId, email, "phoneburner_catalog");
  progressCompanyStatus(companyId, "interested", { source: "system" });
  if (!canPush) return;
  try {
    const r = await ensureOutreachDeal(companyId, ajm ? "ajm" : "catalog", ajm ? "To Contact" : "Interested");
    if (r.dealId) result.pushed++;
    const personId = (sqlite.prepare("SELECT pipedrive_person_id AS p FROM companies WHERE id = ?").get(companyId) as { p: number | null } | undefined)?.p;
    if (personId) await putPersonEmail(personId, email);
  } catch {
    /* per-row best-effort; frame state already updated */
  }
}

export async function backfillCatalogInterest(
  rows: CatalogRow[],
  opts: { dryRun?: boolean; createMissing?: boolean } = {},
): Promise<CatalogBackfillResult> {
  const dryRun = opts.dryRun ?? false;
  const createMissing = opts.createMissing ?? false;
  const canPush = getPipedriveConnectionStatus().connected && !!getPipelineConfig();
  const result: CatalogBackfillResult = {
    total: rows.length, matched: 0, created: 0, emailAdded: 0, alreadyHadEmail: 0, pushed: 0, unmatched: 0, unmatchedSamples: [], dryRun,
  };

  for (const row of rows) {
    const m = matchCompany(row.email);
    if (m) {
      result.matched++;
      if (m.haveEmail) result.alreadyHadEmail++;
      else result.emailAdded++;
      if (!dryRun) await processCompany(m.companyId, row.email, isAjm(m), m.haveEmail, canPush, result);
      continue;
    }

    // No match. Optionally create a new company for a business-domain email.
    const domain = (row.email.split("@")[1] || "").toLowerCase();
    const businessDomain = !!domain && !FREE_DOMAINS.has(domain) && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain);
    if (createMissing && businessDomain) {
      result.created++;
      result.matched++;
      result.emailAdded++;
      if (!dryRun) {
        const id = crypto.randomUUID();
        sqlite
          .prepare(
            `INSERT INTO companies (id, name, website, status, source, created_at, updated_at)
             VALUES (?, ?, ?, 'interested', 'catalog_lead', datetime('now'), datetime('now'))`,
          )
          .run(id, domain, `https://${domain}`);
        await processCompany(id, row.email, false, false, canPush, result);
      }
      continue;
    }

    result.unmatched++;
    if (result.unmatchedSamples.length < 40) result.unmatchedSamples.push(row.email);
  }
  return result;
}

// ── background runner (settings-backed progress, polled by the UI) ───────────

const STATE_KEY = "catalog_interest_backfill_state";
let inFlight = false;

function writeState(s: Record<string, unknown>): void {
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, type, module, updated_at)
       VALUES (?, ?, 'json', 'sales', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(STATE_KEY, JSON.stringify({ ...s, inFlight, at: new Date().toISOString() }));
}
export function readCatalogBackfillState(): Record<string, unknown> | null {
  const r = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(STATE_KEY) as { value: string | null } | undefined;
  if (!r?.value) return null;
  try {
    return { ...(JSON.parse(r.value) as Record<string, unknown>), inFlight };
  } catch {
    return null;
  }
}

/** Kick the backfill in the background; returns immediately. */
export function startCatalogBackfill(
  rows: CatalogRow[],
  opts: { createMissing?: boolean } = {},
): { started: boolean; alreadyRunning?: boolean } {
  if (inFlight) return { started: false, alreadyRunning: true };
  inFlight = true;
  writeState({ state: "running", total: rows.length });
  void (async () => {
    try {
      const r = await backfillCatalogInterest(rows, { dryRun: false, createMissing: opts.createMissing });
      writeState({ state: "done", ...r });
    } catch (e) {
      writeState({ state: "error", error: e instanceof Error ? e.message : String(e) });
    } finally {
      inFlight = false;
    }
  })();
  return { started: true };
}
