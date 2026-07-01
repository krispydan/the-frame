export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { phoneBurnerClient } from "@/modules/sales/lib/phoneburner-client";

/**
 * POST /api/admin/sales/audit-ajm-folder
 *
 * Audits (and optionally corrects) AJM leads that were pushed to the
 * wrong PhoneBurner folder. AJM reactivation leads are tagged `ajm_*`
 * and belong in the "AJM Customer Reactivation" folder (66249536), but
 * the Apify/boutique push swept up qualified_lead rows with a gmaps
 * phone — including AJM leads — into the boutique folder.
 *
 * Body:
 *   { correct?: boolean }   default false = audit only (no writes)
 *     correct=true → for each mis-filed AJM lead: move the PB contact to
 *     the AJM folder (updateContact category_id) and repoint the
 *     phoneburner_folder_pushes row.
 *
 * Returns folder distribution + the list of AJM leads in non-AJM folders.
 * Auth: x-admin-key: jaxy2026
 */
const AJM_FOLDER = "66249536";

interface MisRow {
  push_id: string;
  company_id: string;
  name: string | null;
  folder_id: string;
  pb_contact_id: string | null;
  tags: string | null;
  status: string | null;
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { correct?: boolean } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const correct = body.correct === true;

  // Folder distribution across all pushes.
  const dist = sqlite
    .prepare(
      `SELECT folder_id, COUNT(*) AS n,
              SUM(CASE WHEN lower(co.tags) LIKE '%ajm%' THEN 1 ELSE 0 END) AS ajm_tagged
         FROM phoneburner_folder_pushes pfp
         JOIN companies co ON co.id = pfp.company_id
        GROUP BY folder_id ORDER BY n DESC`,
    )
    .all() as Array<{ folder_id: string; n: number; ajm_tagged: number }>;

  // AJM-tagged companies pushed to a folder that ISN'T the AJM folder.
  const mis = sqlite
    .prepare(
      `SELECT pfp.id AS push_id, pfp.company_id, co.name, pfp.folder_id,
              pfp.pb_contact_id, co.tags, co.status
         FROM phoneburner_folder_pushes pfp
         JOIN companies co ON co.id = pfp.company_id
        WHERE pfp.folder_id != ?
          AND lower(co.tags) LIKE '%ajm%'
        ORDER BY pfp.pushed_at DESC`,
    )
    .all(AJM_FOLDER) as MisRow[];

  if (!correct) {
    return NextResponse.json({
      ok: true,
      mode: "audit",
      ajm_folder: AJM_FOLDER,
      folder_distribution: dist,
      misfiled_count: mis.length,
      misfiled: mis.map((m) => ({
        company_id: m.company_id, name: m.name, folder_id: m.folder_id,
        pb_contact_id: m.pb_contact_id, status: m.status,
        ajm_tags: safeTags(m.tags).filter((t) => t.toLowerCase().includes("ajm")),
      })),
    });
  }

  // Correct: move each PB contact into the AJM folder + repoint the row.
  const results = { moved: 0, no_contact_id: 0, errors: [] as Array<{ company_id: string; reason: string }> };
  const repoint = sqlite.prepare("UPDATE phoneburner_folder_pushes SET folder_id = ? WHERE id = ?");
  const dropDup = sqlite.prepare("DELETE FROM phoneburner_folder_pushes WHERE id = ?");
  const existsAjmRow = sqlite.prepare(
    "SELECT 1 FROM phoneburner_folder_pushes WHERE company_id = ? AND folder_id = ? LIMIT 1",
  );

  for (const m of mis) {
    const cid = m.pb_contact_id ? String(m.pb_contact_id).replace(/\.0$/, "") : "";
    if (!cid) {
      results.no_contact_id++;
      // Still repoint the record so the audit reflects intent.
      try {
        if (existsAjmRow.get(m.company_id, AJM_FOLDER)) dropDup.run(m.push_id);
        else repoint.run(AJM_FOLDER, m.push_id);
      } catch { /* ignore */ }
      continue;
    }
    try {
      await phoneBurnerClient.updateContact(cid, { category_id: AJM_FOLDER });
      // Repoint (or drop if an AJM-folder row already exists → unique index).
      if (existsAjmRow.get(m.company_id, AJM_FOLDER)) dropDup.run(m.push_id);
      else repoint.run(AJM_FOLDER, m.push_id);
      results.moved++;
    } catch (e) {
      results.errors.push({ company_id: m.company_id, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({
    ok: true,
    mode: "correct",
    ajm_folder: AJM_FOLDER,
    misfiled_count: mis.length,
    ...results,
  });
}

function safeTags(t: string | null): string[] {
  if (!t) return [];
  try { const a = JSON.parse(t); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}
