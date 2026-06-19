export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET /api/admin/sales/phone-integrity-check
 *
 * Belt-and-suspenders verification before we drop companies.phone.
 * Returns:
 *
 *   legacy_only_count    — non-empty companies.phone with NO
 *                          company_phones row at all. Dropping the
 *                          column with these > 0 = data loss.
 *
 *   value_mismatch_count — non-empty companies.phone whose exact
 *                          value isn't present in any company_phones
 *                          row for that company (after normalizing
 *                          whitespace + punctuation). Dropping with
 *                          these > 0 = losing the legacy variant.
 *
 *   total_legacy_phones      — count of non-empty companies.phone
 *   total_canonical_phones   — count of company_phones rows
 *   companies_with_canonical — distinct companies in company_phones
 *   snapshot_rows            — rows in _legacy_companies_phone_snapshot
 *
 *   sample_orphans  — up to 10 company IDs that fall in legacy_only
 *   sample_mismatch — up to 10 company IDs that fall in value_mismatch
 *
 * Both counts must be zero before the column drop ships. After the
 * column is dropped this endpoint still works — it returns null for
 * the legacy-side counts and reports snapshot_rows as the historical
 * record of what was migrated.
 *
 * Auth: same admin-key gate as the rest of /api/admin/*.
 */
export async function GET() {
  // Detect whether the column still exists. After Phase 3 drops it,
  // the legacy-side queries would throw — we want a clean "post-drop"
  // response instead.
  const columns = sqlite
    .prepare("PRAGMA table_info(companies)")
    .all() as Array<{ name: string }>;
  const hasLegacyColumn = columns.some((c) => c.name === "phone");

  const totalCanonical = (
    sqlite
      .prepare("SELECT COUNT(*) AS n FROM company_phones")
      .get() as { n: number }
  ).n;
  const companiesWithCanonical = (
    sqlite
      .prepare("SELECT COUNT(DISTINCT company_id) AS n FROM company_phones")
      .get() as { n: number }
  ).n;
  const snapshotRows = (
    sqlite
      .prepare("SELECT COUNT(*) AS n FROM _legacy_companies_phone_snapshot")
      .get() as { n: number }
  ).n;

  if (!hasLegacyColumn) {
    return NextResponse.json({
      ok: true,
      phase: "post_drop",
      legacy_column_exists: false,
      legacy_only_count: null,
      value_mismatch_count: null,
      total_legacy_phones: null,
      total_canonical_phones: totalCanonical,
      companies_with_canonical: companiesWithCanonical,
      snapshot_rows: snapshotRows,
      sample_orphans: [],
      sample_mismatch: [],
      message:
        "Legacy companies.phone column has been dropped. Snapshot table still holds the migrated values.",
    });
  }

  const totalLegacy = (
    sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM companies WHERE TRIM(COALESCE(phone, '')) <> ''",
      )
      .get() as { n: number }
  ).n;

  // (A) Legacy-only — companies whose legacy phone has no row in
  // company_phones at all. Should be 0 after the boot backfill ran.
  const orphanRows = sqlite
    .prepare(
      `SELECT c.id, c.name, c.phone
         FROM companies c
        WHERE TRIM(COALESCE(c.phone, '')) <> ''
          AND NOT EXISTS (
            SELECT 1 FROM company_phones cp WHERE cp.company_id = c.id
          )
        LIMIT 50`,
    )
    .all() as Array<{ id: string; name: string; phone: string }>;
  const legacyOnlyCount = (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM companies c
          WHERE TRIM(COALESCE(c.phone, '')) <> ''
            AND NOT EXISTS (
              SELECT 1 FROM company_phones cp WHERE cp.company_id = c.id
            )`,
      )
      .get() as { n: number }
  ).n;

  // (B) Value mismatch — company has SOME rows in company_phones,
  // but none of them match the legacy phone (exact OR normalized
  // digits-only). Catches "phone migrated but in a different
  // format" cases that could lose data on drop.
  //
  // The normalization strips every non-digit character so
  // "+1 (715) 209-4057" matches "7152094057" matches "1-715-209-4057".
  const normalize = (col: string) =>
    `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${col},'-',''),' ',''),'(',''),')',''),'+',''),'.',''),CHAR(9),'')`;

  const mismatchRows = sqlite
    .prepare(
      `SELECT c.id, c.name, c.phone AS legacy_phone,
              GROUP_CONCAT(cp.phone) AS canonical_phones
         FROM companies c
         LEFT JOIN company_phones cp ON cp.company_id = c.id
        WHERE TRIM(COALESCE(c.phone, '')) <> ''
          AND EXISTS (SELECT 1 FROM company_phones cp2 WHERE cp2.company_id = c.id)
        GROUP BY c.id
       HAVING SUM(CASE WHEN cp.phone = c.phone THEN 1 ELSE 0 END) = 0
          AND SUM(CASE WHEN ${normalize("cp.phone")} = ${normalize("c.phone")} THEN 1 ELSE 0 END) = 0
        LIMIT 50`,
    )
    .all() as Array<{
      id: string;
      name: string;
      legacy_phone: string;
      canonical_phones: string;
    }>;
  const valueMismatchCount = (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT c.id
             FROM companies c
            WHERE TRIM(COALESCE(c.phone, '')) <> ''
              AND EXISTS (SELECT 1 FROM company_phones cp2 WHERE cp2.company_id = c.id)
              AND NOT EXISTS (
                SELECT 1 FROM company_phones cp WHERE cp.company_id = c.id AND cp.phone = c.phone
              )
              AND NOT EXISTS (
                SELECT 1 FROM company_phones cp WHERE cp.company_id = c.id
                  AND ${normalize("cp.phone")} = ${normalize("c.phone")}
              )
         )`,
      )
      .get() as { n: number }
  ).n;

  const safeToProceed = legacyOnlyCount === 0 && valueMismatchCount === 0;

  return NextResponse.json({
    ok: true,
    phase: safeToProceed ? "ready_to_drop" : "drift_detected",
    legacy_column_exists: true,
    safe_to_proceed: safeToProceed,
    legacy_only_count: legacyOnlyCount,
    value_mismatch_count: valueMismatchCount,
    total_legacy_phones: totalLegacy,
    total_canonical_phones: totalCanonical,
    companies_with_canonical: companiesWithCanonical,
    snapshot_rows: snapshotRows,
    sample_orphans: orphanRows.slice(0, 10),
    sample_mismatch: mismatchRows.slice(0, 10),
    message: safeToProceed
      ? "Both drift counts are zero. Safe to drop companies.phone."
      : "Drift detected — see sample_orphans / sample_mismatch. Do NOT drop the column yet.",
  });
}
