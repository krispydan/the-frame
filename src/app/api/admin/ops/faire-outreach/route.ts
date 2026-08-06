/**
 * Ops endpoint for the outreach sequence engine's Phase 0 data migration.
 *
 *   GET  /api/admin/ops/faire-outreach        -> coverage stats (read-only)
 *   POST /api/admin/ops/faire-outreach?confirm=1
 *        body: { contacts?, skips?, sends?, campaign?, dryRun? }
 *        -> imports retailer tokens / skiplist / send history
 *
 * Auth: x-ops-key header (see src/lib/ops-auth.ts). POST also needs ?confirm=1.
 * Logic lives in the lib so the same code can be called from a UI route later.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import { sqlite } from "@/lib/db";
import { importFaireOutreach, backfillTokensFromOrders } from "@/modules/sales/lib/faire-outreach-import";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;

  const one = (sql: string) => (sqlite.prepare(sql).get() as { n: number }).n;
  try {
    return NextResponse.json({
      ok: true,
      companies: {
        total: one("SELECT COUNT(*) n FROM companies"),
        withFaireToken: one("SELECT COUNT(*) n FROM companies WHERE faire_retailer_id IS NOT NULL AND faire_retailer_id <> ''"),
        doNotContact: one("SELECT COUNT(*) n FROM companies WHERE do_not_contact = 1"),
      },
      faireBrandLinks: sqlite.prepare(
        `SELECT brand, COUNT(*) AS companies, SUM(do_not_contact) AS suppressed
           FROM company_faire_accounts GROUP BY brand`).all(),
      outreachMessages: {
        total: one("SELECT COUNT(*) n FROM outreach_messages"),
        sent: one("SELECT COUNT(*) n FROM outreach_messages WHERE status IN ('sent','sent_unverified')"),
        linkedToCompany: one("SELECT COUNT(*) n FROM outreach_messages WHERE company_id IS NOT NULL"),
        lastSentAt: (sqlite.prepare("SELECT MAX(sent_at) v FROM outreach_messages").get() as { v: string | null }).v,
        byBrand: sqlite.prepare(
          `SELECT brand, COUNT(*) AS n, MAX(sent_at) AS last_at
             FROM outreach_messages GROUP BY brand`).all(),
      },
      faireOrders: {
        orders: one("SELECT COUNT(*) n FROM orders WHERE channel = 'faire'"),
        companiesWithFaireOrders: one("SELECT COUNT(DISTINCT company_id) n FROM orders WHERE channel = 'faire' AND company_id IS NOT NULL"),
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const denied = requireOpsToken(req, { mutation: true });
  if (denied) return denied;

  try {
    const body = await req.json();
    if (body.action === "backfill_tokens") {
      return NextResponse.json({ ok: true, ...backfillTokensFromOrders() });
    }
    const summary = importFaireOutreach({
      contacts: body.contacts,
      skips: body.skips,
      sends: body.sends,
      campaign: body.campaign,
      brand: body.brand,
      dryRun: body.dryRun !== false && body.dryRun !== undefined ? !!body.dryRun : false,
    });
    return NextResponse.json({ ok: true, dryRun: !!body.dryRun, summary });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
