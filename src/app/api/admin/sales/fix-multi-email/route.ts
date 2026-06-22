export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * POST /api/admin/sales/fix-multi-email
 *
 * Storeleads scrape joined multiple emails per company with a colon
 * ("info@x.com:sales@x.com"). After the legacy-companies-email-to-
 * contacts migration, these junk strings live in contacts.email
 * verbatim — one row holding a multi-email blob instead of N clean
 * rows. Fix in place: split each blob into N parts and replace the
 * single corrupted row with N clean rows.
 *
 * Also fixes campaign_leads.email which is a SNAPSHOT taken at push
 * time and may have inherited the multi-email string from the era
 * before the migration.
 *
 * Idempotent: single-email rows untouched, re-runs are no-ops.
 *
 * Body: { dryRun?: boolean }
 * Auth: x-admin-key: jaxy2026
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { dryRun?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body OK */ }
  const dryRun = body.dryRun === true;

  // (A) contacts.email multi-blobs — one corrupted row per company
  // gets split into N clean rows. Skip protocol-style values.
  const contactCandidates = sqlite.prepare(
    `SELECT id, company_id, email, is_primary FROM contacts
       WHERE email LIKE '%:%@%'
         AND email NOT LIKE 'mailto:%'`,
  ).all() as Array<{
    id: string;
    company_id: string;
    email: string;
    is_primary: number;
  }>;

  type ContactSplit = {
    source_id: string;
    company_id: string;
    is_primary: number;
    before: string;
    parts: string[];
  };
  const contactSplits: ContactSplit[] = [];
  for (const r of contactCandidates) {
    const parts = r.email
      .split(/[:;|,]/)
      .map((p) => p.trim().toLowerCase())
      .filter((p) => p.includes("@"));
    if (parts.length === 0) continue;
    if (parts.length === 1 && parts[0] === r.email.trim().toLowerCase()) continue;
    contactSplits.push({
      source_id: r.id,
      company_id: r.company_id,
      is_primary: r.is_primary,
      before: r.email,
      parts,
    });
  }

  // (B) campaign_leads.email blobs — same predicate, simpler fix
  // (just replace with the first part).
  const clCandidates = sqlite.prepare(
    `SELECT id, email FROM campaign_leads
       WHERE email LIKE '%:%@%'
         AND email NOT LIKE 'mailto:%'`,
  ).all() as Array<{ id: string; email: string }>;
  const clUpdates: Array<{ id: string; before: string; after: string }> = [];
  for (const r of clCandidates) {
    const first = r.email.split(/[:;|,]/)[0].trim().toLowerCase();
    if (first && first.includes("@") && first !== r.email.trim().toLowerCase()) {
      clUpdates.push({ id: r.id, before: r.email, after: first });
    }
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      counts: {
        contactRowsToSplit: contactSplits.length,
        cleanContactsThatWillBeCreated: contactSplits.reduce(
          (a, s) => a + s.parts.length,
          0,
        ),
        campaignLeadsToUpdate: clUpdates.length,
      },
      sample: {
        contacts: contactSplits.slice(0, 10),
        campaignLeads: clUpdates.slice(0, 10),
      },
    });
  }

  const deleteCorrupt = sqlite.prepare(
    `DELETE FROM contacts WHERE id = ?`,
  );
  const insertSplit = sqlite.prepare(
    `INSERT OR IGNORE INTO contacts
       (id, company_id, store_id, first_name, last_name, title,
        email, phone, is_primary, source, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, NULL, NULL, ?, NULL, ?, 'multi_email_split',
             datetime('now'), datetime('now'))`,
  );
  const updCl = sqlite.prepare(
    `UPDATE campaign_leads SET email = ? WHERE id = ?`,
  );

  let cleanRowsCreated = 0;
  const txn = sqlite.transaction(() => {
    for (const s of contactSplits) {
      deleteCorrupt.run(s.source_id);
      for (let i = 0; i < s.parts.length; i++) {
        const isPrimary = i === 0 ? s.is_primary : 0;
        const r = insertSplit.run(
          crypto.randomUUID(),
          s.company_id,
          s.parts[i],
          isPrimary,
        );
        if (r.changes > 0) cleanRowsCreated++;
      }
    }
    for (const u of clUpdates) updCl.run(u.after, u.id);
  });
  txn();

  return NextResponse.json({
    ok: true,
    counts: {
      contactRowsSplit: contactSplits.length,
      cleanContactRowsCreated: cleanRowsCreated,
      campaignLeadsUpdated: clUpdates.length,
    },
    sample: {
      contacts: contactSplits.slice(0, 5),
      campaignLeads: clUpdates.slice(0, 5),
    },
  });
}
