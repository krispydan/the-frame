export const dynamic = "force-dynamic";
// Long-running orchestrator — verifies up to ~8K leads (~20 min at
// concurrency 10) then pushes. Cloudflare cuts external requests at ~100s,
// so this is meant to be triggered from inside Railway:
//
//   railway ssh 'nohup curl -X POST http://localhost:$PORT/api/admin/sales/verify-and-push \\
//     -H "x-admin-key: jaxy2026" -H "Content-Type: application/json" \\
//     -d "{ ... }" > /tmp/vp.json 2>&1 & echo PID=$!'
//
// Then poll /tmp/vp.json or the prod DB to track progress.
export const maxDuration = 1800; // 30 min cap

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { verifyProspectEmails } from "@/modules/sales/lib/neverbounce/verify-prospects";
import { handleSyncRequest } from "@/modules/sales/lib/instantly-sync";

// Email is canonical in contacts now. SQL fragments centralize the
// pattern so the heavy verify-and-push queries stay readable.
const HAS_EMAIL_EXISTS = `EXISTS (
  SELECT 1 FROM contacts ct
  WHERE ct.company_id = c.id
    AND TRIM(COALESCE(ct.email, '')) <> ''
)`;
const PRIMARY_EMAIL_SUBQ = `(
  SELECT ct.email FROM contacts ct
  WHERE ct.company_id = c.id
    AND TRIM(COALESCE(ct.email, '')) <> ''
  ORDER BY ct.is_primary DESC, ct.created_at ASC
  LIMIT 1
)`;

/**
 * POST /api/admin/sales/verify-and-push
 *
 * Resolves a tag-pattern cohort, runs NeverBounce verification on every
 * lead that needs it, then pushes the verified survivors into the named
 * the-frame Campaign (which mirrors to its Instantly campaign).
 *
 * Wraps the v1 endpoints' logic so it can be triggered from the CLI
 * without a login session. Same hard filters apply:
 *   - has email
 *   - status NOT IN (rejected, customer)
 *   - email_verification_status IN (valid, catchall)   ← gate
 *   - not already in THIS campaign
 *   - not already on Instantly anywhere (cross-campaign email dedup)
 *
 * Body:
 *   {
 *     tagPattern: string,         // e.g. "%industry_women_s_clothing%"
 *     campaignId: string,         // the-frame campaign UUID
 *     action?: "verify_only" | "push_only" | "verify_then_push",  // default verify_then_push
 *     maxLeads?: number,          // cap (default no cap)
 *     concurrency?: number,       // NeverBounce concurrency (default 10)
 *     dryRun?: boolean            // preview only — no verify, no push
 *   }
 *
 * Auth: x-admin-key: jaxy2026
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    tagPattern?: string;
    campaignId?: string;
    action?: "verify_only" | "push_only" | "verify_then_push";
    maxLeads?: number;
    concurrency?: number;
    dryRun?: boolean;
    /** When true, push every eligible lead regardless of NeverBounce
     *  verification status. Use when you want Instantly's built-in
     *  email validator to handle bounces instead. Default false. */
    skipVerificationFilter?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }

  if (!body.tagPattern || !body.campaignId) {
    return NextResponse.json(
      { error: "tagPattern + campaignId required" },
      { status: 400 },
    );
  }

  const action = body.action ?? "verify_then_push";
  const concurrency = body.concurrency ?? 10;
  const dryRun = body.dryRun === true;
  const skipVerificationFilter = body.skipVerificationFilter === true;

  // ── 1. Resolve the cohort ──
  const campaign = sqlite.prepare(
    `SELECT id, name, instantly_campaign_id FROM campaigns WHERE id = ? LIMIT 1`,
  ).get(body.campaignId) as { id: string; name: string; instantly_campaign_id: string | null } | undefined;
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  if (!campaign.instantly_campaign_id) {
    return NextResponse.json(
      { error: "Campaign not synced to Instantly" },
      { status: 400 },
    );
  }

  const eligibleQuery = `
    SELECT c.id, ${PRIMARY_EMAIL_SUBQ} AS email,
           c.email_verification_status, COALESCE(c.icp_score, -1) AS icp_score
      FROM companies c
     WHERE c.tags LIKE ?
       AND ${HAS_EMAIL_EXISTS}
       AND c.status NOT IN ('rejected', 'customer')
       AND NOT EXISTS (SELECT 1 FROM campaign_leads cl
                       WHERE cl.campaign_id = ? AND cl.company_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM campaign_leads cl2
                       WHERE LOWER(cl2.email) = LOWER(${PRIMARY_EMAIL_SUBQ})
                         AND cl2.instantly_lead_id IS NOT NULL)
     ORDER BY icp_score DESC
  `;
  const allEligible = sqlite.prepare(eligibleQuery).all(
    body.tagPattern, campaign.id,
  ) as Array<{
    id: string;
    email: string;
    email_verification_status: string | null;
    icp_score: number;
  }>;

  const cohort = body.maxLeads != null ? allEligible.slice(0, body.maxLeads) : allEligible;

  const stats = {
    cohortSize: cohort.length,
    eligibleTotal: allEligible.length,
    pendingVerification: cohort.filter(
      (c) => c.email_verification_status === null || c.email_verification_status === "error",
    ).length,
    alreadyVerifiedValid: cohort.filter(
      (c) => c.email_verification_status === "valid" || c.email_verification_status === "catchall",
    ).length,
    alreadyVerifiedBad: cohort.filter(
      (c) =>
        c.email_verification_status != null &&
        !["valid", "catchall", "error"].includes(c.email_verification_status),
    ).length,
  };

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      action,
      campaign: { id: campaign.id, name: campaign.name },
      stats,
      preview: cohort.slice(0, 10).map((c) => ({
        id: c.id,
        email: c.email,
        verificationStatus: c.email_verification_status,
        icpScore: c.icp_score,
      })),
    });
  }

  // ── 2. Verify (if requested) ──
  let verifyStats: Awaited<ReturnType<typeof verifyProspectEmails>> | null = null;
  if (action !== "push_only" && stats.pendingVerification > 0) {
    const pendingIds = cohort
      .filter((c) => c.email_verification_status === null || c.email_verification_status === "error")
      .map((c) => c.id);
    verifyStats = await verifyProspectEmails({
      companyIds: pendingIds,
      concurrency,
    });
  }

  if (action === "verify_only") {
    return NextResponse.json({
      ok: true,
      action,
      campaign: { id: campaign.id, name: campaign.name },
      stats,
      verify: verifyStats,
    });
  }

  // ── 3. Re-read verification verdicts + push the qualifying ones ──
  // verify-prospects writes verdicts to companies; re-read so we
  // pick up the fresh status for each row in the cohort.
  const cohortIds = cohort.map((c) => c.id);
  if (cohortIds.length === 0) {
    return NextResponse.json({
      ok: true, action, campaign, stats, verify: verifyStats, push: { inserted: 0 },
    });
  }
  const idPh = cohortIds.map(() => "?").join(",");
  // Gate: when skipVerificationFilter is on, push every eligible lead
  // and let Instantly's built-in validator handle bounces.
  const verificationGate = skipVerificationFilter
    ? ""
    : "AND c.email_verification_status IN ('valid','catchall')";
  const verified = sqlite.prepare(
    `SELECT c.id, ${PRIMARY_EMAIL_SUBQ} AS email FROM companies c
      WHERE c.id IN (${idPh})
        ${verificationGate}
        AND c.status NOT IN ('rejected','customer')
        AND NOT EXISTS (SELECT 1 FROM campaign_leads cl
                        WHERE cl.campaign_id = ? AND cl.company_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM campaign_leads cl2
                        WHERE LOWER(cl2.email) = LOWER(${PRIMARY_EMAIL_SUBQ})
                          AND cl2.instantly_lead_id IS NOT NULL)`,
  ).all(...cohortIds, campaign.id) as Array<{ id: string; email: string }>;

  const insert = sqlite.prepare(
    `INSERT OR IGNORE INTO campaign_leads
       (id, campaign_id, company_id, contact_id, email, status, created_at)
     VALUES (?, ?, ?, NULL, ?, 'queued', datetime('now'))`,
  );
  let inserted = 0;
  const txn = sqlite.transaction(() => {
    for (const c of verified) {
      const res = insert.run(crypto.randomUUID(), campaign.id, c.id, c.email);
      if (res.changes > 0) inserted++;
    }
  });
  txn();

  // ── 4. Kick the Instantly sync to ship the new queued rows ──
  let syncSummary: unknown = null;
  try {
    syncSummary = await handleSyncRequest();
  } catch (e) {
    return NextResponse.json({
      ok: true,
      action,
      campaign: { id: campaign.id, name: campaign.name },
      stats,
      verify: verifyStats,
      push: { inserted, syncError: e instanceof Error ? e.message : String(e) },
    });
  }

  return NextResponse.json({
    ok: true,
    action,
    campaign: { id: campaign.id, name: campaign.name },
    stats,
    verify: verifyStats,
    push: { inserted, sync: syncSummary },
  });
}
