/**
 * Phone-storage helpers — `company_phones` is the canonical store.
 *
 * Use these from any write path that wants to record a phone number
 * for a company. Direct INSERTs/UPDATEs against `companies.phone` are
 * deprecated and will fail once the column is dropped.
 */

import { sqlite } from "@/lib/db";
import type { Statement } from "better-sqlite3";

// Lazy prepare — top-level `sqlite.prepare(...)` runs at module load,
// which during Next.js build-phase page-data collection executes
// against an empty in-memory DB (no tables yet) and crashes the build
// with "no such table: company_phones". Defer until first call so the
// real DB is initialized first.
let insertStmt: Statement | null = null;
function getInsertStmt(): Statement {
  if (!insertStmt) {
    insertStmt = sqlite.prepare(
      `INSERT OR IGNORE INTO company_phones
        (id, company_id, phone, source, is_primary, created_at, updated_at)
       VALUES (
        lower(hex(randomblob(16))), ?, ?, ?, 1,
        datetime('now'), datetime('now')
       )`,
    );
  }
  return insertStmt;
}

/**
 * Add a phone for a company. Idempotent — duplicate (company_id, phone)
 * pairs are silently dropped by the unique index. Empty/whitespace
 * inputs are no-ops.
 *
 * The first phone added for a company becomes primary; later phones
 * default to is_primary=1 as well but tiebreak by created_at so the
 * earliest one wins in the cache trigger. If you want to *promote*
 * a specific phone to primary, demote the others first.
 *
 * @param companyId  Required.
 * @param phone      Any string — empty/whitespace gracefully skipped.
 * @param source     Free-text provenance tag — 'manual', 'outscraper',
 *                   'web_scrape', 'storeleads', 'chrome_ext', etc.
 *                   Used by the integrity check and for debugging.
 */
export function addCompanyPhone(
  companyId: string,
  phone: string | null | undefined,
  source: string,
): void {
  if (!companyId) return;
  const trimmed = (phone ?? "").trim();
  if (!trimmed) return;
  getInsertStmt().run(companyId, trimmed, source);
}
