export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

const MAX_ITEMS = 10000;

/**
 * POST /api/v1/integrations/storeleads/upsert-phones
 *
 * Persist every phone number we found in StoreLeads back into the
 * Frame's company_phones table so a future re-run of the dialer
 * export doesn't need to re-query the API, AND so per-call notes
 * can be attached to a stable phone-number row.
 *
 * Body:
 *   {
 *     items: [
 *       { company_id: string, phones: string[], source?: string },
 *       ...
 *     ]
 *   }
 *
 * Behaviour:
 * - INSERT OR IGNORE on (company_id, phone) — second run is a no-op
 *   per row.
 * - First phone for a (company_id) where no row currently has
 *   is_primary=1 → that one gets marked is_primary=1.
 * - source defaults to 'storeleads' if omitted.
 *
 * Pre-migration the route also wrote companies.phone as a legacy
 * cache; that's now handled by the boot-time cache-refresh triggers
 * (and the column itself is going away), so this route only writes
 * the canonical store.
 *
 * Returns counts so the script can summarise.
 */
export async function POST(req: NextRequest) {
  let body: {
    items?: Array<{ company_id?: string; phones?: string[]; source?: string }>;
  } = {};
  try { body = await req.json(); } catch { /* ok */ }

  const items = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS) : [];
  if (items.length === 0) {
    return NextResponse.json({ ok: false, error: "items[] required" }, { status: 400 });
  }

  const insertPhone = sqlite.prepare(
    `INSERT OR IGNORE INTO company_phones
       (id, company_id, phone, source, is_primary, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, datetime('now'), datetime('now'))`,
  );
  const markPrimary = sqlite.prepare(
    `UPDATE company_phones SET is_primary = 1, updated_at = datetime('now')
       WHERE company_id = ? AND phone = ?`,
  );
  const hasPrimaryQ = sqlite.prepare(
    `SELECT 1 AS x FROM company_phones WHERE company_id = ? AND is_primary = 1 LIMIT 1`,
  );
  let totalPhonesIn = 0;
  let phoneRowsInserted = 0;
  let primariesAssigned = 0;
  let itemsProcessed = 0;
  const skipped: Array<{ company_id: string; reason: string }> = [];

  const txn = sqlite.transaction(() => {
    for (const it of items) {
      if (!it.company_id || !Array.isArray(it.phones)) {
        skipped.push({
          company_id: String(it.company_id ?? "?"),
          reason: "missing company_id or phones",
        });
        continue;
      }
      // Normalise: trim, drop empties, dedupe in case the caller
      // accidentally included the same number twice in one item.
      const seen = new Set<string>();
      const phones: string[] = [];
      for (const raw of it.phones) {
        const p = String(raw ?? "").trim();
        if (!p) continue;
        if (seen.has(p)) continue;
        seen.add(p);
        phones.push(p);
      }
      if (phones.length === 0) continue;

      totalPhonesIn += phones.length;
      const source = it.source ?? "storeleads";

      for (const p of phones) {
        const r = insertPhone.run(crypto.randomUUID(), it.company_id, p, source);
        if (r.changes > 0) phoneRowsInserted++;
      }

      // If no row for this company is currently flagged primary,
      // bless the first phone we just touched.
      const hasPrimary = hasPrimaryQ.get(it.company_id);
      if (!hasPrimary) {
        const r = markPrimary.run(it.company_id, phones[0]);
        if (r.changes > 0) primariesAssigned++;
      }

      itemsProcessed++;
    }
  });
  txn();

  return NextResponse.json({
    ok: true,
    itemsProcessed,
    totalPhonesIn,
    phoneRowsInserted,            // genuinely new rows in company_phones
    duplicatesSkipped: totalPhonesIn - phoneRowsInserted,
    primariesAssigned,             // companies that just got their first is_primary row
    skipped: skipped.slice(0, 10),
  });
}
