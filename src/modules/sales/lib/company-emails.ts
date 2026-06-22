/**
 * Email-storage helpers — `contacts` is the canonical store.
 *
 * Use these from any write path that wants to record an email for a
 * company. Direct INSERTs/UPDATEs against `companies.email` are
 * deprecated and will fail once that column is dropped.
 *
 * Multiple emails per company are first-class (different decision
 * makers at the same store). Each call creates one contacts row,
 * idempotent via the unique-by-(company_id, lower(email)) semantics
 * that will be enforced in a follow-up commit. The is_primary
 * heuristic: if the company has no existing contacts, the row
 * becomes primary; otherwise it's an additional non-primary
 * alternate so the user's intended primary isn't disrupted.
 */

import { sqlite } from "@/lib/db";
import type { Statement } from "better-sqlite3";

// Lazy prepare — top-level `sqlite.prepare(...)` runs at module load,
// which during Next.js build-phase page-data collection executes
// against an empty in-memory DB and crashes the build with "no such
// table: contacts". Defer until first call so the real DB is
// initialized first.
let insertStmt: Statement | null = null;
function getInsertStmt(): Statement {
  if (!insertStmt) {
    insertStmt = sqlite.prepare(
      `INSERT INTO contacts (
         id, company_id, store_id, first_name, last_name, title,
         email, phone, is_primary, source, created_at, updated_at
       )
       SELECT
         lower(hex(randomblob(16))),
         ?,            -- company_id
         NULL, NULL, NULL, NULL,
         LOWER(TRIM(?)),  -- email
         NULL,
         CASE
           WHEN EXISTS (SELECT 1 FROM contacts cx WHERE cx.company_id = ?)
           THEN 0 ELSE 1
         END,
         ?,            -- source
         datetime('now'),
         datetime('now')
       WHERE NOT EXISTS (
         SELECT 1 FROM contacts ct
         WHERE ct.company_id = ?
           AND LOWER(TRIM(ct.email)) = LOWER(TRIM(?))
       )`,
    );
  }
  return insertStmt;
}

/**
 * Add an email contact for a company. Idempotent — if a contacts row
 * already exists with the same lower(email) for this company, no row
 * is inserted. Empty/whitespace inputs are no-ops.
 *
 * First email added for a company becomes primary. Subsequent emails
 * are is_primary=0 alternates. To change primary, demote the current
 * one first.
 *
 * @param companyId  Required.
 * @param email      Any string — empty/whitespace gracefully skipped.
 * @param source     Free-text provenance tag — 'manual', 'storeleads',
 *                   'chrome_ext', 'faire_webhook', 'shopify_webhook',
 *                   'web_scrape', etc. Used by the integrity check
 *                   and for debugging.
 */
export function addCompanyEmail(
  companyId: string,
  email: string | null | undefined,
  source: string,
): void {
  if (!companyId) return;
  const trimmed = (email ?? "").trim();
  if (!trimmed) return;
  // 5 params: company_id, email, company_id (for EXISTS), source,
  // company_id (for WHERE NOT EXISTS dedup), email (for WHERE).
  getInsertStmt().run(companyId, trimmed, companyId, source, companyId, trimmed);
}
