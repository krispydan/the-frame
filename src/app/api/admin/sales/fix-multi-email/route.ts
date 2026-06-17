export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * POST /api/admin/sales/fix-multi-email
 *
 * Storeleads scrape grabbed multiple contact emails per store and joined
 * them with a colon ("info@x.com:sales@x.com"). These get pushed to
 * Instantly as a single string and the whole batch 40004's. Fix in-place
 * by keeping only the part before the FIRST colon — usually the primary
 * info@ / contact@ address.
 *
 * Updates both companies.email and campaign_leads.email so the values
 * stay consistent. Idempotent — single-email rows untouched.
 *
 * Body:
 *   { dryRun?: boolean }     // default false
 *
 * Auth: x-admin-key: jaxy2026
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { dryRun?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body OK */ }
  const dryRun = body.dryRun === true;

  // Find candidates: any email containing a colon and at least one @ on
  // each side. Skip protocol-style values (mailto:foo@x).
  const candidates = sqlite.prepare(
    `SELECT id, email FROM companies
       WHERE email LIKE '%:%@%'
         AND email NOT LIKE 'mailto:%'`,
  ).all() as Array<{ id: string; email: string }>;

  const updates: Array<{ id: string; before: string; after: string }> = [];
  for (const r of candidates) {
    const first = r.email.split(":")[0].trim();
    if (first && first.includes("@") && first !== r.email) {
      updates.push({ id: r.id, before: r.email, after: first });
    }
  }

  // Also fix campaign_leads.email rows independently — some may be split
  // from contacts.email not companies.email, so don't rely on JOIN.
  const clCandidates = sqlite.prepare(
    `SELECT id, email FROM campaign_leads
       WHERE email LIKE '%:%@%'
         AND email NOT LIKE 'mailto:%'`,
  ).all() as Array<{ id: string; email: string }>;
  const clUpdates: Array<{ id: string; before: string; after: string }> = [];
  for (const r of clCandidates) {
    const first = r.email.split(":")[0].trim();
    if (first && first.includes("@") && first !== r.email) {
      clUpdates.push({ id: r.id, before: r.email, after: first });
    }
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      counts: {
        companiesToUpdate: updates.length,
        campaignLeadsToUpdate: clUpdates.length,
      },
      sample: {
        companies: updates.slice(0, 10),
        campaignLeads: clUpdates.slice(0, 10),
      },
    });
  }

  const updCompany = sqlite.prepare(
    `UPDATE companies SET email = ?, updated_at = datetime('now') WHERE id = ?`,
  );
  const updCl = sqlite.prepare(
    `UPDATE campaign_leads SET email = ? WHERE id = ?`,
  );
  const txn = sqlite.transaction(() => {
    for (const u of updates) updCompany.run(u.after, u.id);
    for (const u of clUpdates) updCl.run(u.after, u.id);
  });
  txn();

  return NextResponse.json({
    ok: true,
    counts: {
      companiesUpdated: updates.length,
      campaignLeadsUpdated: clUpdates.length,
    },
    sample: {
      companies: updates.slice(0, 5),
      campaignLeads: clUpdates.slice(0, 5),
    },
  });
}
