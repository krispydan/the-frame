export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * POST /api/admin/sales/phone-fix-mismatches
 *
 * Companion to phone-integrity-check. For every company whose legacy
 * companies.phone value doesn't appear in company_phones (after the
 * normalize-and-strip-leading-1 collapse used by the integrity check),
 * INSERT-OR-IGNORE the legacy variant as a non-primary alternate row.
 * That way both formats survive the column drop and the integrity
 * check goes clean on the next call.
 *
 * Idempotent — uniqueness constraint on (company_id, phone) makes
 * re-runs no-ops. Returns { patched: N, samples: [...] } so you can
 * see exactly what was added.
 *
 * Use case: rare format edge cases (non-US numbers with different
 * country-code prefixes, junk phones with non-standard digit counts)
 * that the normalize step can't collapse. Hit this once, then the
 * boot block's integrity-guarded column drop proceeds normally.
 *
 * Auth: same admin-key gate as the rest of /api/admin/*.
 */
export async function POST() {
  const columns = sqlite
    .prepare("PRAGMA table_info(companies)")
    .all() as Array<{ name: string }>;
  const hasLegacyColumn = columns.some((c) => c.name === "phone");

  if (!hasLegacyColumn) {
    return NextResponse.json({
      ok: true,
      message: "Legacy companies.phone column already dropped — nothing to patch.",
      patched: 0,
      samples: [],
    });
  }

  // Same normalize used in the integrity check — strip punctuation,
  // then drop a leading "1" if the remaining digits are exactly 11
  // (so "+1 555-1234" collapses to "5551234567" matches a bare
  // "5551234567" canonical row).
  const stripped = (col: string) =>
    `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${col},'-',''),' ',''),'(',''),')',''),'+',''),'.',''),CHAR(9),'')`;
  const normalize = (col: string) => `CASE
    WHEN LENGTH(${stripped(col)}) = 11 AND SUBSTR(${stripped(col)}, 1, 1) = '1'
    THEN SUBSTR(${stripped(col)}, 2)
    ELSE ${stripped(col)}
  END`;

  // Pull every drift case. Same predicate as the integrity check —
  // legacy phone non-empty, company has SOME canonical rows, but none
  // of them match the legacy value exactly or after normalization.
  const drift = sqlite
    .prepare(
      `SELECT c.id AS company_id, c.name, c.phone AS legacy_phone
         FROM companies c
        WHERE TRIM(COALESCE(c.phone, '')) <> ''
          AND EXISTS (SELECT 1 FROM company_phones cp2 WHERE cp2.company_id = c.id)
          AND NOT EXISTS (
            SELECT 1 FROM company_phones cp WHERE cp.company_id = c.id AND cp.phone = c.phone
          )
          AND NOT EXISTS (
            SELECT 1 FROM company_phones cp WHERE cp.company_id = c.id
              AND ${normalize("cp.phone")} = ${normalize("c.phone")}
          )`,
    )
    .all() as Array<{ company_id: string; name: string; legacy_phone: string }>;

  if (drift.length === 0) {
    return NextResponse.json({
      ok: true,
      message: "No drift detected — integrity check is already clean.",
      patched: 0,
      samples: [],
    });
  }

  // is_primary=0 because the existing row is primary; we're adding
  // the legacy formatting variant as an alternate so the column drop
  // doesn't lose it.
  const insert = sqlite.prepare(
    `INSERT OR IGNORE INTO company_phones
       (id, company_id, phone, source, is_primary, created_at, updated_at)
     VALUES (
       lower(hex(randomblob(16))),
       ?, ?, 'legacy_variant_backfill', 0,
       datetime('now'), datetime('now')
     )`,
  );

  let patched = 0;
  const samples: Array<{ company_id: string; name: string; phone: string }> = [];
  const txn = sqlite.transaction(() => {
    for (const d of drift) {
      const r = insert.run(d.company_id, d.legacy_phone.trim());
      if (r.changes > 0) {
        patched++;
        if (samples.length < 20) {
          samples.push({
            company_id: d.company_id,
            name: d.name,
            phone: d.legacy_phone,
          });
        }
      }
    }
  });
  txn();

  return NextResponse.json({
    ok: true,
    message: `Patched ${patched} legacy phone variant(s) into company_phones as non-primary alternates. Hit /api/admin/sales/phone-integrity-check to confirm zero drift, then trigger a redeploy so the boot-block column drop proceeds.`,
    drift_count: drift.length,
    patched,
    samples,
  });
}
