export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * POST /api/admin/sales/migrate-status-pipeline
 *
 * One-shot migration + backfill from the legacy companies.status enum
 * (new | contacted | qualified | rejected | customer) to the new
 * lead-gen pipeline:
 *
 *   prospect | not_qualified | qualified_lead | interested
 *   catalog_sent | revisit_later | not_interested | ghosted | customer
 *
 * Six steps, all inside one SQLite transaction so it's atomic.
 * Idempotent and re-runnable — each step is "set if not already at or
 * past the target".
 *
 *   Phase A: literal value rename (new→prospect, qualified→qualified_lead,
 *            rejected→not_qualified, contacted→qualified_lead).
 *   Phase B: every company with ANY campaign_leads row gets
 *            qualified_lead (unless already at a later stage). This is
 *            Daniel's explicit ask: "if we send the company to Instantly,
 *            the status should be qualified — backdate for all leads."
 *   Phase C: every company with a lead_interested webhook event gets
 *            interested.
 *   Phase D: every company with a lead_not_interested OR lead_unsubscribed
 *            webhook event gets not_interested (unless already further).
 *   Phase E: every company with a Shopify wholesale order OR Faire order
 *            gets customer (skipped if the orders table can't be matched
 *            — wholesale + Faire ingestion is an open task per the
 *            6-19 plan).
 *
 * Body:
 *   { dryRun?: boolean }   default false
 *
 * Auth: x-admin-key: jaxy2026
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { dryRun?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body OK */
  }
  const dryRun = body.dryRun === true;

  // Snapshot the current distribution so we can show before/after.
  const beforeRows = sqlite
    .prepare("SELECT status, COUNT(*) AS n FROM companies GROUP BY 1 ORDER BY 2 DESC")
    .all() as Array<{ status: string | null; n: number }>;
  const before: Record<string, number> = {};
  for (const r of beforeRows) before[r.status ?? "(null)"] = r.n;

  // Plan the writes — but execute as one transaction so dry-run is
  // a pure preview and the live run is atomic.
  const phaseACounts = {
    new_to_prospect: countMatching(
      "SELECT COUNT(*) AS n FROM companies WHERE status = 'new'",
    ),
    qualified_to_qualified_lead: countMatching(
      "SELECT COUNT(*) AS n FROM companies WHERE status = 'qualified'",
    ),
    rejected_to_not_qualified: countMatching(
      "SELECT COUNT(*) AS n FROM companies WHERE status = 'rejected'",
    ),
    contacted_to_qualified_lead: countMatching(
      "SELECT COUNT(*) AS n FROM companies WHERE status = 'contacted'",
    ),
  };

  // Phase B target set — has a campaign_leads row AND current status is
  // prospect/new (the entry-stage). Anything past qualified_lead stays put.
  const phaseBCount = countMatching(
    `SELECT COUNT(DISTINCT cl.company_id) AS n
       FROM campaign_leads cl
       JOIN companies c ON c.id = cl.company_id
      WHERE c.status IN ('prospect', 'new')`,
  );

  // Phase C — every company with a lead_interested event whose current
  // status is at or below qualified_lead.
  const phaseCCount = countMatching(
    `SELECT COUNT(DISTINCT c.id) AS n
       FROM companies c
       JOIN campaign_leads cl ON cl.company_id = c.id
      WHERE c.status IN ('prospect', 'new', 'qualified_lead')
        AND lower(cl.email) IN (
          SELECT lower(lead_email) FROM instantly_webhook_events
           WHERE event_type = 'lead_interested'
        )`,
  );

  // Phase D — every company with a hard-no event whose current status
  // isn't already past it.
  const phaseDCount = countMatching(
    `SELECT COUNT(DISTINCT c.id) AS n
       FROM companies c
       JOIN campaign_leads cl ON cl.company_id = c.id
      WHERE c.status NOT IN ('not_interested', 'customer', 'ghosted', 'revisit_later')
        AND lower(cl.email) IN (
          SELECT lower(lead_email) FROM instantly_webhook_events
           WHERE event_type IN ('lead_not_interested', 'lead_unsubscribed')
        )`,
  );

  // Phase E — skipped pending order-ingestion wiring per Daniel's 6-19
  // plan. Counted anyway so the response shows what would happen once
  // we plumb it in.
  let phaseECount = 0;
  let phaseENote = "skipped — order ingestion → customer wiring not yet in place";
  try {
    // If the orders table is matchable, count anyway. This is a soft try.
    const row = sqlite
      .prepare(
        `SELECT COUNT(DISTINCT company_id) AS n
           FROM orders
          WHERE company_id IS NOT NULL`,
      )
      .get() as { n: number };
    phaseECount = row.n;
    phaseENote = `orders table has ${row.n} distinct companies — count shown but not applied in this migration`;
  } catch {
    /* table or column doesn't exist as expected — skip silently */
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      before,
      plan: {
        phase_A_value_renames: phaseACounts,
        phase_B_qualified_from_campaign_leads: phaseBCount,
        phase_C_interested_from_webhook_events: phaseCCount,
        phase_D_not_interested_from_webhook_events: phaseDCount,
        phase_E_customer_from_orders: { count: phaseECount, note: phaseENote },
      },
    });
  }

  // Execute. One transaction so we don't end up half-migrated on error.
  const txn = sqlite.transaction(() => {
    // Phase A — direct value renames.
    sqlite.prepare("UPDATE companies SET status = 'prospect',       updated_at = datetime('now') WHERE status = 'new'").run();
    sqlite.prepare("UPDATE companies SET status = 'qualified_lead', updated_at = datetime('now') WHERE status = 'qualified'").run();
    sqlite.prepare("UPDATE companies SET status = 'not_qualified',  updated_at = datetime('now') WHERE status = 'rejected'").run();
    sqlite.prepare("UPDATE companies SET status = 'qualified_lead', updated_at = datetime('now') WHERE status = 'contacted'").run();

    // Phase B — any company in campaign_leads → qualified_lead.
    sqlite
      .prepare(
        `UPDATE companies
            SET status = 'qualified_lead', updated_at = datetime('now')
          WHERE id IN (SELECT DISTINCT company_id FROM campaign_leads WHERE company_id IS NOT NULL)
            AND status IN ('prospect', 'new')`,
      )
      .run();

    // Phase C — any company with lead_interested event → interested.
    sqlite
      .prepare(
        `UPDATE companies
            SET status = 'interested', updated_at = datetime('now')
          WHERE id IN (
                  SELECT DISTINCT cl.company_id FROM campaign_leads cl
                   WHERE lower(cl.email) IN (
                     SELECT lower(lead_email) FROM instantly_webhook_events
                      WHERE event_type = 'lead_interested'
                   )
                )
            AND status IN ('prospect', 'qualified_lead', 'new')`,
      )
      .run();

    // Phase D — any company with a hard-no event → not_interested.
    sqlite
      .prepare(
        `UPDATE companies
            SET status = 'not_interested', updated_at = datetime('now')
          WHERE id IN (
                  SELECT DISTINCT cl.company_id FROM campaign_leads cl
                   WHERE lower(cl.email) IN (
                     SELECT lower(lead_email) FROM instantly_webhook_events
                      WHERE event_type IN ('lead_not_interested', 'lead_unsubscribed')
                   )
                )
            AND status NOT IN ('not_interested', 'customer', 'ghosted', 'revisit_later', 'catalog_sent')`,
      )
      .run();

    // Phase E intentionally not applied here — order-driven customer
    // marking lands when the order-ingestion hooks are wired (separate task).
  });
  txn();

  const afterRows = sqlite
    .prepare("SELECT status, COUNT(*) AS n FROM companies GROUP BY 1 ORDER BY 2 DESC")
    .all() as Array<{ status: string | null; n: number }>;
  const after: Record<string, number> = {};
  for (const r of afterRows) after[r.status ?? "(null)"] = r.n;

  return NextResponse.json({
    ok: true,
    before,
    after,
    counts_applied: {
      phase_A: phaseACounts,
      phase_B: phaseBCount,
      phase_C: phaseCCount,
      phase_D: phaseDCount,
      phase_E_skipped: phaseENote,
    },
  });
}

function countMatching(query: string): number {
  const row = sqlite.prepare(query).get() as { n: number } | undefined;
  return row?.n ?? 0;
}
