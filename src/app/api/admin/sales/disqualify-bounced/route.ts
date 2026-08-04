export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { disqualifyBouncedLeads } from "@/modules/sales/lib/instantly-webhooks";

/**
 * Disqualify leads whose email already bounced.
 *
 * GET  → how many are affected, without changing anything
 * POST → apply it
 *
 * Header: x-admin-key: jaxy2026
 */

const COUNT_SQL = `
  SELECT COUNT(*) n FROM companies c
   WHERE c.status IN ('prospect', 'qualified_lead')
     AND (
       EXISTS (SELECT 1 FROM campaign_leads cl
                WHERE cl.company_id = c.id AND cl.status = 'bounced')
       OR EXISTS (SELECT 1 FROM activity_feed af
                   WHERE af.entity_type = 'company' AND af.entity_id = c.id
                     AND af.event_type = 'instantly_email_bounced')
     )`;

export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const pending = (sqlite.prepare(COUNT_SQL).get() as { n: number }).n;
  return NextResponse.json({ ok: true, pending });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const result = disqualifyBouncedLeads(Number(body.limit) || 500);
  return NextResponse.json({
    ok: true,
    scanned: result.scanned,
    disqualifiedCount: result.disqualified.length,
    // Capped: the point is a spot-check that the right rows moved, not a dump.
    sample: result.disqualified.slice(0, 25),
  });
}
