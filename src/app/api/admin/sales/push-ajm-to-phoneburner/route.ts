export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { phoneBurnerClient } from "@/modules/sales/lib/phoneburner-client";
import { formatToPbPhone } from "@/modules/sales/lib/phone-utils";

/**
 * POST /api/admin/sales/push-ajm-to-phoneburner
 *
 * Pushes AJM reactivation leads (tagged ajm_*) to the "AJM Customer
 * Reactivation" PhoneBurner folder (66249536) for Christina to dial.
 *
 * Excludes anyone who has already placed an order with us (orders row)
 * or is marked a customer — we don't cold-dial existing customers.
 * Idempotent: leads already pushed to the AJM folder are skipped.
 *
 * Body: { folder_id?: "66249536", limit?: number, dryRun?: boolean }
 * Auth: x-admin-key: jaxy2026
 */
const AJM_FOLDER = "66249536";

interface Row {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  domain: string | null;
  website: string | null;
  primary_phone: string | null;
  primary_email: string | null;
  first_name: string | null;
  last_name: string | null;
}

export async function POST(req: NextRequest) {
  try {
    return await handle(req);
  } catch (e) {
    console.error("[push-ajm-to-phoneburner] crashed:", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

async function handle(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { folder_id?: string; limit?: number; dryRun?: boolean } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const folderId = String(body.folder_id || AJM_FOLDER).trim();
  const limit = Math.min(5000, Math.max(1, body.limit ?? 2000));

  const cohort = sqlite
    .prepare(
      `SELECT c.id, c.name, c.city, c.state, c.domain, c.website,
              (SELECT cp.phone FROM company_phones cp
                WHERE cp.company_id = c.id
                ORDER BY cp.is_primary DESC, cp.created_at ASC LIMIT 1) AS primary_phone,
              (SELECT ct.email FROM contacts ct
                WHERE ct.company_id = c.id AND TRIM(COALESCE(ct.email,'')) <> ''
                ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS primary_email,
              (SELECT ct.first_name FROM contacts ct
                WHERE ct.company_id = c.id ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS first_name,
              (SELECT ct.last_name FROM contacts ct
                WHERE ct.company_id = c.id ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS last_name
         FROM companies c
        WHERE lower(COALESCE(c.tags,'')) LIKE '%ajm%'
          AND c.status != 'customer'
          AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.company_id = c.id)
          AND EXISTS (SELECT 1 FROM company_phones cp WHERE cp.company_id = c.id)
          AND NOT EXISTS (
            SELECT 1 FROM phoneburner_folder_pushes pfp
             WHERE pfp.company_id = c.id AND pfp.folder_id = ?
          )
        ORDER BY c.icp_score DESC NULLS LAST
        LIMIT ?`,
    )
    .all(folderId, limit) as Row[];

  // Diagnostics on the full AJM universe (for the summary).
  const universe = sqlite
    .prepare(
      `SELECT
         COUNT(*) AS ajm_total,
         SUM(CASE WHEN c.status = 'customer' THEN 1 ELSE 0 END) AS customers,
         SUM(CASE WHEN EXISTS (SELECT 1 FROM orders o WHERE o.company_id = c.id) THEN 1 ELSE 0 END) AS with_orders,
         SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM company_phones cp WHERE cp.company_id = c.id) THEN 1 ELSE 0 END) AS no_phone
       FROM companies c WHERE lower(COALESCE(c.tags,'')) LIKE '%ajm%'`,
    )
    .get() as { ajm_total: number; customers: number; with_orders: number; no_phone: number };

  if (body.dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      folder_id: folderId,
      cohort_total: cohort.length,
      ajm_universe: universe,
      sample: cohort.slice(0, 10).map((c) => ({
        id: c.id, name: c.name, city: c.city, state: c.state, phone: c.primary_phone, email: c.primary_email,
      })),
    });
  }

  if (cohort.length === 0) {
    return NextResponse.json({ ok: true, cohort_total: 0, pushed: 0, message: "Nothing to push.", ajm_universe: universe });
  }

  // Resolve owner_id (PB requires it on every create).
  let ownerId: string;
  try {
    const cached = sqlite.prepare("SELECT value FROM settings WHERE key='phoneburner_owner_id' LIMIT 1")
      .get() as { value: string | null } | undefined;
    ownerId = cached?.value || (await phoneBurnerClient.discoverOwnerId()) || "";
    if (!ownerId) throw new Error("owner_id unavailable");
  } catch (e) {
    return NextResponse.json({ ok: false, error: `owner_id: ${e instanceof Error ? e.message : e}` }, { status: 502 });
  }

  const stamp = sqlite.prepare(
    `INSERT OR IGNORE INTO phoneburner_folder_pushes
       (id, company_id, folder_id, pb_contact_id, phone_pushed, pushed_at, error)
     VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, datetime('now'), ?)`,
  );

  let pushed = 0, alreadyPushed = 0, skippedNoPhone = 0;
  const errors: Array<{ company_id: string; reason: string }> = [];

  for (const row of cohort) {
    const formatted = formatToPbPhone(row.primary_phone);
    if (!formatted) { skippedNoPhone++; continue; }
    try {
      const created = await phoneBurnerClient.createContact({
        owner_id: ownerId,
        first_name: (row.first_name || row.name).slice(0, 64),
        last_name: row.last_name || row.state || "",
        email: row.primary_email || undefined,
        phone: formatted,
        category_id: folderId,
        notes: `AJM reactivation lead${row.city ? ` — ${row.city}` : ""}${row.state ? `, ${row.state}` : ""}`,
        user_id: row.id,
        custom_fields: [
          { name: "Company ID", type: "text", value: row.id },
          { name: "Company Name", type: "text", value: row.name },
          { name: "Website", type: "url", value: row.website || "" },
          { name: "Domain", type: "text", value: row.domain || "" },
        ].filter((f) => f.value),
        on_duplicate: "skip",
      });
      stamp.run(row.id, folderId, created.id || null, formatted, null);
      pushed++;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (/duplicate|already exists/i.test(reason)) {
        stamp.run(row.id, folderId, null, formatted, "pb_duplicate");
        alreadyPushed++;
      } else {
        errors.push({ company_id: row.id, reason });
        stamp.run(row.id, folderId, null, formatted, reason.slice(0, 300));
      }
    }
  }

  return NextResponse.json({
    ok: true,
    folder_id: folderId,
    cohort_total: cohort.length,
    pushed,
    already_pushed: alreadyPushed,
    skipped_no_phone: skippedNoPhone,
    errors,
    ajm_universe: universe,
    note: `Pushed ${pushed} AJM leads to folder ${folderId} for Christina.`,
  });
}
