export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { completeOpenCallActivityForCompany } from "@/modules/sales/lib/pipedrive-call-sync";
import { listOpenActivitiesForPerson } from "@/modules/sales/lib/pipedrive-client";

/**
 * Close the Pipedrive "Call" activity when a lead was called in PhoneBurner.
 *
 *   GET  ?companyId=UUID              → show the person's open activities (dry)
 *   POST ?companyId=UUID              → close the earliest open call activity
 *                                       (simulates a connected call — for testing)
 *   POST ?backfillMinutes=1440        → for recent CONNECTED calls in the call
 *                                       log, close each lead's open call activity
 *                                       (retroactive fix; &commit=true to apply)
 *
 * Auth: x-admin-key: jaxy2026.
 */
export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId required" }, { status: 400 });
  const personId = (sqlite.prepare("SELECT pipedrive_person_id AS id FROM companies WHERE id = ?").get(companyId) as { id: number | null } | undefined)?.id ?? null;
  if (!personId) return NextResponse.json({ ok: true, companyId, personId: null, note: "company has no pipedrive_person_id" });
  const open = await listOpenActivitiesForPerson(personId);
  return NextResponse.json({
    ok: true,
    companyId,
    personId,
    openActivities: open.map((a) => ({ id: a.id, type: a.type, subject: a.subject, due_date: a.due_date, done: a.done })),
  });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId");
  const backfillMinutes = url.searchParams.get("backfillMinutes");

  if (companyId) {
    const result = await completeOpenCallActivityForCompany(companyId, { connected: true, disposition: "Manual test", durationSeconds: null });
    return NextResponse.json({ ok: true, companyId, ...result });
  }

  if (backfillMinutes) {
    const mins = Math.max(1, parseInt(backfillMinutes, 10));
    const commit = url.searchParams.get("commit") === "true";
    // Distinct companies with a CONNECTED call in the window.
    const rows = sqlite
      .prepare(
        `SELECT DISTINCT company_id, MAX(connected) AS connected, MAX(disposition_label) AS disposition
           FROM phoneburner_call_log
          WHERE company_id IS NOT NULL
            AND called_at >= datetime('now', ?)
            AND connected = 1
          GROUP BY company_id`,
      )
      .all(`-${mins} minutes`) as Array<{ company_id: string; connected: number; disposition: string | null }>;

    if (!commit) {
      return NextResponse.json({ ok: true, commit: false, connectedCallCompanies: rows.length, sample: rows.slice(0, 10).map((r) => r.company_id) });
    }
    let closed = 0,
      noActivity = 0;
    const closedIds: number[] = [];
    for (const r of rows) {
      const res = await completeOpenCallActivityForCompany(r.company_id, { connected: true, disposition: r.disposition, durationSeconds: null });
      if (res.closed) {
        closed++;
        if (res.activityId) closedIds.push(res.activityId);
      } else {
        noActivity++;
      }
    }
    return NextResponse.json({ ok: true, commit: true, companies: rows.length, closed, noActivity, closedIds: closedIds.slice(0, 50) });
  }

  return NextResponse.json({ error: "provide companyId (test one) or backfillMinutes (retroactive)" }, { status: 400 });
}
