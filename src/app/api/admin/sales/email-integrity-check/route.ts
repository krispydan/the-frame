export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET /api/admin/sales/email-integrity-check
 *
 * Pre-migration audit for dropping `companies.email`. Tells us
 * exactly how much drift exists between companies.email and the
 * contacts table BEFORE we backfill — so we can decide strict
 * (UNIQUE(company_id, lower(email))) vs lenient (allow dupes for
 * now, dedupe later).
 *
 * Returns:
 *   legacy_only_count     companies with non-empty companies.email
 *                         but NO matching contacts.email row for
 *                         that company (case-insensitive). These
 *                         are the rows the backfill will create.
 *
 *   duplicate_email_companies
 *                         companies that already have 2+ contacts
 *                         rows with the same lower(email). Same
 *                         buyer recorded twice. These need dedupe
 *                         before a UNIQUE constraint will work.
 *
 *   case_mismatch_count   companies where companies.email differs
 *                         from contacts.email only in case
 *                         (Info@x.com vs info@x.com). Indicates
 *                         the inconsistent-lowercasing problem the
 *                         migration will fix in one pass.
 *
 *   multi_email_legacy    companies.email values containing
 *                         separators (:;|,) — the unsplit junk
 *                         that fix-multi-email exists to clean.
 *
 *   contacts_count        total contacts rows
 *   companies_with_email  companies with non-empty email
 *
 *   sample_orphans        up to 10 company IDs + emails that will
 *                         get backfilled as new contacts rows
 *   sample_duplicates     up to 10 (company_id, email, count) trios
 *                         where dedupe is needed
 *
 * After companies.email is dropped this endpoint returns a "post_drop"
 * response, same pattern as phone-integrity-check.
 *
 * Auth: same admin-key gate as the rest of /api/admin/*.
 */
export async function GET() {
  const columns = sqlite
    .prepare("PRAGMA table_info(companies)")
    .all() as Array<{ name: string }>;
  const hasLegacyColumn = columns.some((c) => c.name === "email");

  const contactsCount = (
    sqlite
      .prepare("SELECT COUNT(*) AS n FROM contacts")
      .get() as { n: number }
  ).n;

  if (!hasLegacyColumn) {
    return NextResponse.json({
      ok: true,
      phase: "post_drop",
      legacy_column_exists: false,
      contacts_count: contactsCount,
      message:
        "companies.email column has already been dropped. Contacts is the sole source of truth.",
    });
  }

  const companiesWithEmail = (
    sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM companies WHERE TRIM(COALESCE(email, '')) <> ''",
      )
      .get() as { n: number }
  ).n;

  // (A) Orphans — companies.email is set but NO contacts row for that
  // company has a matching email (case-insensitive). After backfill
  // this MUST be zero or we'd lose data on column drop.
  const legacyOnlyCount = (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM companies c
          WHERE TRIM(COALESCE(c.email, '')) <> ''
            AND NOT EXISTS (
              SELECT 1 FROM contacts ct
              WHERE ct.company_id = c.id
                AND LOWER(TRIM(ct.email)) = LOWER(TRIM(c.email))
            )`,
      )
      .get() as { n: number }
  ).n;

  const orphanSamples = sqlite
    .prepare(
      `SELECT c.id, c.name, c.email
         FROM companies c
        WHERE TRIM(COALESCE(c.email, '')) <> ''
          AND NOT EXISTS (
            SELECT 1 FROM contacts ct
            WHERE ct.company_id = c.id
              AND LOWER(TRIM(ct.email)) = LOWER(TRIM(c.email))
          )
        LIMIT 10`,
    )
    .all() as Array<{ id: string; name: string; email: string }>;

  // (B) Case mismatch — a contacts row exists for the same company
  // with the same lower(email) but DIFFERENT case from companies.email.
  // The backfill (which writes lowercased) will produce a row that
  // matches the case-insensitive comparison; this count tells us how
  // many existing contacts rows have the "wrong" case today.
  const caseMismatchCount = (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM companies c
         WHERE TRIM(COALESCE(c.email, '')) <> ''
           AND EXISTS (
             SELECT 1 FROM contacts ct
             WHERE ct.company_id = c.id
               AND LOWER(TRIM(ct.email)) = LOWER(TRIM(c.email))
               AND TRIM(ct.email) != TRIM(c.email)
           )`,
      )
      .get() as { n: number }
  ).n;

  // (C) Duplicate emails within a company — same lower(email), >1
  // contacts row. Decides strict-vs-lenient: if this is non-zero we
  // can't add a UNIQUE constraint without a dedupe pass.
  const duplicateEmailCompanies = (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM (
          SELECT company_id, LOWER(TRIM(email)) AS norm_email, COUNT(*) AS dup_count
            FROM contacts
           WHERE TRIM(COALESCE(email, '')) <> ''
           GROUP BY company_id, LOWER(TRIM(email))
          HAVING dup_count > 1
         )`,
      )
      .get() as { n: number }
  ).n;

  const duplicateSamples = sqlite
    .prepare(
      `SELECT ct.company_id, LOWER(TRIM(ct.email)) AS email,
              COUNT(*) AS dup_count,
              GROUP_CONCAT(ct.id) AS contact_ids
         FROM contacts ct
        WHERE TRIM(COALESCE(ct.email, '')) <> ''
        GROUP BY ct.company_id, LOWER(TRIM(ct.email))
       HAVING dup_count > 1
        LIMIT 10`,
    )
    .all() as Array<{
      company_id: string;
      email: string;
      dup_count: number;
      contact_ids: string;
    }>;

  // (D) Multi-email legacy strings — companies.email contains a
  // separator. The fix-multi-email route handles these but the count
  // tells us how dirty the source data is.
  const multiEmailLegacy = (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM companies
          WHERE email LIKE '%:%'
             OR email LIKE '%;%'
             OR email LIKE '%|%'
             OR email LIKE '%,%'`,
      )
      .get() as { n: number }
  ).n;

  const safeToProceedWithBackfill = true; // backfill itself is safe regardless
  const readyForUniqueConstraint = duplicateEmailCompanies === 0;

  return NextResponse.json({
    ok: true,
    phase: "audit",
    legacy_column_exists: true,
    legacy_only_count: legacyOnlyCount,
    case_mismatch_count: caseMismatchCount,
    duplicate_email_companies: duplicateEmailCompanies,
    multi_email_legacy: multiEmailLegacy,
    companies_with_email: companiesWithEmail,
    contacts_count: contactsCount,
    safe_to_proceed_with_backfill: safeToProceedWithBackfill,
    ready_for_unique_constraint: readyForUniqueConstraint,
    sample_orphans: orphanSamples,
    sample_duplicates: duplicateSamples,
    recommendation:
      duplicateEmailCompanies === 0
        ? "Lean strict — duplicates are zero, backfill can include a UNIQUE(company_id, lower(email)) constraint."
        : duplicateEmailCompanies < 100
          ? "Lean strict with dedup — small duplicate count, can resolve inline during backfill."
          : duplicateEmailCompanies < 1000
            ? "Lean lenient first — backfill without constraint, then run a dedupe admin endpoint, then add constraint."
            : "Pause and investigate — high duplicate count suggests upstream data-quality issue.",
  });
}
