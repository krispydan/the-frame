export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { splitMulti } from "@/modules/sales/lib/storeleads/import";

/**
 * POST /api/v1/integrations/storeleads/cleanup-phones
 *
 * Backfill fix for the bug where StoreLeads CSV imports stored
 * multi-phone strings verbatim into companies.phone — e.g.
 * `+1 916-584-4540:+1 916-...` — because the firstOf() splitter
 * didn't include `:` as a separator. PhoneBurner choked on these.
 *
 * Walks every companies row whose phone contains any of `:`, `;`,
 * `,`, or `|`, splits the value, and:
 *   - Replaces companies.phone with the FIRST non-empty part
 *     (preserves the primary number that was already being
 *     displayed in the UI — just truncates the junk).
 *   - Inserts every part (including the first) into company_phones
 *     so the full set is captured for the dialer flow.
 *
 * Body (all optional):
 *   { dryRun?: boolean, limit?: number }   // default limit 5000
 *
 * Idempotent — second run only touches rows that newly accumulate
 * junk separators. Safe to re-run.
 */
export async function POST(req: NextRequest) {
  let body: { dryRun?: boolean; limit?: number } = {};
  try { body = await req.json(); } catch { /* ok */ }

  const limit = Math.max(1, Math.min(50000, body.limit ?? 5000));

  // The bad rows: phone contains any of the four common separators.
  // Using GLOB instead of LIKE for cheap multi-char matching.
  const candidates = sqlite.prepare(
    `SELECT id, phone
       FROM companies
      WHERE phone IS NOT NULL
        AND (phone LIKE '%:%'
          OR phone LIKE '%;%'
          OR phone LIKE '%|%'
          -- Comma is more delicate: many real phones are written
          -- "(555) 123-4567, ext 100" or as a list. We split on
          -- comma in firstOf too, so be consistent and clean it
          -- here as well.
          OR phone LIKE '%,%')
      LIMIT ?`,
  ).all(limit) as Array<{ id: string; phone: string }>;

  if (candidates.length === 0) {
    return NextResponse.json({
      ok: true, scanned: 0, fixed: 0, phonesRecovered: 0,
      sample: [],
    });
  }

  if (body.dryRun) {
    return NextResponse.json({
      ok: true, dryRun: true, scanned: candidates.length,
      sample: candidates.slice(0, 10).map((c) => ({
        id: c.id, original: c.phone, split: splitMulti(c.phone),
      })),
    });
  }

  const updatePrimary = sqlite.prepare(
    `UPDATE companies SET phone = ?, updated_at = datetime('now') WHERE id = ?`,
  );
  const insertPhone = sqlite.prepare(
    `INSERT OR IGNORE INTO company_phones
       (id, company_id, phone, source, is_primary, created_at, updated_at)
     VALUES (?, ?, ?, 'storeleads', 0, datetime('now'), datetime('now'))`,
  );
  const hasPrimaryQ = sqlite.prepare(
    `SELECT 1 AS x FROM company_phones
       WHERE company_id = ? AND is_primary = 1 LIMIT 1`,
  );
  const markPrimary = sqlite.prepare(
    `UPDATE company_phones SET is_primary = 1, updated_at = datetime('now')
       WHERE company_id = ? AND phone = ?`,
  );

  let fixed = 0;
  let phonesRecovered = 0;
  let alreadyClean = 0;
  const sampleOut: Array<Record<string, unknown>> = [];

  const txn = sqlite.transaction(() => {
    for (const c of candidates) {
      const parts = splitMulti(c.phone);
      if (parts.length === 0) continue;
      if (parts.length === 1 && parts[0] === c.phone.trim()) {
        // Was a false positive (LIKE %,% matched but the trim left
        // exactly one value). Nothing to do.
        alreadyClean++;
        continue;
      }

      // Keep the first part as the displayed primary. Every part
      // (including the first) lands in company_phones for the
      // dialer flow.
      updatePrimary.run(parts[0], c.id);
      fixed++;

      for (const p of parts) {
        const r = insertPhone.run(crypto.randomUUID(), c.id, p);
        if (r.changes > 0) phonesRecovered++;
      }
      if (!hasPrimaryQ.get(c.id)) {
        markPrimary.run(c.id, parts[0]);
      }

      if (sampleOut.length < 10) {
        sampleOut.push({ id: c.id, original: c.phone, kept: parts[0], parts });
      }
    }
  });
  txn();

  return NextResponse.json({
    ok: true,
    scanned: candidates.length,
    fixed,
    alreadyClean,
    phonesRecovered,
    sample: sampleOut,
    remainingHint:
      candidates.length === limit
        ? "Hit the limit — re-run to pick up the rest"
        : "All known bad rows handled this call",
  });
}
