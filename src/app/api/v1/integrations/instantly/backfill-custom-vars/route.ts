export const dynamic = "force-dynamic";
// PATCH /leads/{id} takes ~200-400ms on Instantly's side, so 4 concurrent
// × ~300ms = ~75 leads/sec ceiling. We hard-cap at 1000 leads per call
// so a 4k-lead backfill is 4 quick clicks rather than one 60s request
// that risks Cloudflare's edge timeout.
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { instantlyClient } from "@/modules/sales/lib/instantly-client";
import { buildCustomVariables } from "@/modules/sales/lib/instantly-sync";

const MAX_PER_CALL = 1000;
const CONCURRENCY = 4;

/**
 * POST /api/v1/integrations/instantly/backfill-custom-vars
 *
 * Backfill custom variables (city, industry, ICP tier, estimated
 * sales, etc.) onto Instantly leads that were pushed BEFORE the
 * custom-variable mapping landed (commit b7c3264).
 *
 * Walks campaign_leads where instantly_lead_id IS NOT NULL, joins
 * companies + contacts, builds the same custom-variable bag the push
 * path uses, and PATCHes each lead in Instantly.
 *
 * Idempotent — re-runnable. Variables that already match get re-sent
 * (Instantly treats this as a no-op write). Tracks a per-row
 * `instantly_custom_vars_backfilled_at` so subsequent calls can skip
 * what's already done.
 *
 * Body (all optional):
 *   {
 *     since?: ISO string   // only backfill rows where the
 *                          // campaign_lead was created after this
 *                          // (default: all)
 *     campaignId?: string  // limit to one local campaign
 *     limit?: number       // 1..1000 (default 1000)
 *     dryRun?: boolean     // skip the PATCH, just report what
 *                          // would happen
 *     force?: boolean      // re-backfill rows already marked done
 *   }
 */
export async function POST(req: NextRequest) {
  let body: {
    since?: string;
    campaignId?: string;
    limit?: number;
    dryRun?: boolean;
    force?: boolean;
    /** NULL out all backfilled_at marks before processing, so the simple
     *  IS NULL filter runs from scratch. Use after a known-bad earlier
     *  run marked rows "done" that didn't actually land. */
    resetMarks?: boolean;
    /** Only run the reset, don't continue with a backfill pass. */
    resetOnly?: boolean;
  } = {};
  try { body = await req.json(); } catch { /* ok */ }

  const limit = Math.max(1, Math.min(MAX_PER_CALL, body.limit ?? MAX_PER_CALL));

  // Make sure the tracking column exists. Idempotent — survives a
  // clean DB just fine, and on prod the second-call cost is zero.
  try {
    sqlite.exec(
      "ALTER TABLE campaign_leads ADD COLUMN instantly_custom_vars_backfilled_at TEXT",
    );
  } catch { /* already exists */ }

  // resetMarks: NULL out all backfilled_at timestamps so the simple
  // IS NULL filter (non-force mode) processes everything from
  // scratch. Use this when prior backfill runs marked rows "done"
  // that didn't actually land in Instantly — e.g. the pre-fix runs
  // that PATCHed with the wrong body shape.
  //
  // Done ONCE at the top of the request; subsequent calls skip the
  // reset and just process normally.
  if (body.resetMarks) {
    const reset = sqlite.prepare(
      `UPDATE campaign_leads
          SET instantly_custom_vars_backfilled_at = NULL
        WHERE instantly_lead_id IS NOT NULL
          AND instantly_custom_vars_backfilled_at IS NOT NULL`,
    ).run();
    // Caller asked for a reset-only with no follow-up work — return
    // immediately so they can confirm before kicking off the loop.
    if (body.resetOnly) {
      return NextResponse.json({
        ok: true, reset: true, cleared: reset.changes,
      });
    }
  }

  const where: string[] = ["cl.instantly_lead_id IS NOT NULL"];
  const params: unknown[] = [];
  if (body.since) {
    where.push("cl.created_at >= ?");
    params.push(body.since);
  }
  if (body.campaignId) {
    where.push("cl.campaign_id = ?");
    params.push(body.campaignId);
  }
  if (!body.force) {
    where.push("cl.instantly_custom_vars_backfilled_at IS NULL");
  }

  // For non-force mode this is "rows still needing a backfill." For
  // force=true we instead count "rows last backfilled before this
  // request started" — otherwise the counter never decrements
  // (every row is always force-eligible) and the client can't tell
  // when to stop the loop.
  const runStartedAt = new Date().toISOString();
  const remainingCountSql = body.force
    ? `SELECT COUNT(*) AS c FROM campaign_leads cl
        WHERE ${where.join(" AND ")}
          AND (cl.instantly_custom_vars_backfilled_at IS NULL
               OR cl.instantly_custom_vars_backfilled_at < ?)`
    : `SELECT COUNT(*) AS c FROM campaign_leads cl WHERE ${where.join(" AND ")}`;
  const remainingCountParams = body.force ? [...params, runStartedAt] : params;
  const remainingBefore = (sqlite.prepare(remainingCountSql)
    .get(...remainingCountParams) as { c: number }).c;

  // Pull the same company + contact context the push path joins on,
  // so buildCustomVariables() produces the identical bag we would
  // have shipped if the mapping had been in place at push time.
  const rows = sqlite.prepare(
    `SELECT cl.id              as cl_id,
            cl.instantly_lead_id,
            co.name      as company_name,
            co.website   as website,
            co.domain    as domain,
            co.city      as city,
            co.state     as state,
            co.country   as country,
            co.industry  as industry,
            co.category  as category,
            co.segment   as segment,
            co.icp_tier  as icp_tier,
            co.icp_score as icp_score,
            co.ecom_platform                as ecom_platform,
            co.employee_count               as employee_count,
            co.estimated_yearly_sales_cents as estimated_yearly_sales_cents,
            co.estimated_monthly_visits     as estimated_monthly_visits,
            co.instagram_url                as instagram_url,
            co.facebook_url                 as facebook_url,
            co.tiktok_url                   as tiktok_url,
            ct.title     as contact_title
       FROM campaign_leads cl
       LEFT JOIN companies co ON co.id = cl.company_id
       LEFT JOIN contacts  ct ON ct.id = cl.contact_id
      WHERE ${where.join(" AND ")}
      -- Order by the backfill timestamp so each call moves forward
      -- through the list — even with force=true, which doesn't filter
      -- on backfilled_at. NULLs (never touched) come first, then the
      -- oldest backfills. When we markDone(NOW) a row, it moves to
      -- the end of the queue for the next call.
      ORDER BY (cl.instantly_custom_vars_backfilled_at IS NULL) DESC,
               cl.instantly_custom_vars_backfilled_at ASC,
               cl.created_at ASC
      LIMIT ?`,
  ).all(...params, limit) as Array<Record<string, unknown>>;

  if (rows.length === 0) {
    return NextResponse.json({
      ok: true, scanned: 0, updated: 0, skippedEmpty: 0, errors: 0,
      remaining: remainingBefore,
    });
  }

  if (body.dryRun) {
    const sample = rows.slice(0, 5).map((r) => ({
      cl_id: r.cl_id,
      instantly_lead_id: r.instantly_lead_id,
      vars: buildCustomVariables(r),
    }));
    return NextResponse.json({
      ok: true, dryRun: true, scanned: rows.length,
      remaining: remainingBefore, sample,
    });
  }

  const markDone = sqlite.prepare(
    `UPDATE campaign_leads
        SET instantly_custom_vars_backfilled_at = ?
      WHERE id = ?`,
  );

  let updated = 0;
  let skippedEmpty = 0;
  let errors = 0;
  const errorSamples: Array<{ leadId: string; message: string }> = [];

  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const i = cursor++;
      const row = rows[i];
      const leadId = String(row.instantly_lead_id ?? "");
      const clId = String(row.cl_id ?? "");
      if (!leadId) continue;

      const vars = buildCustomVariables(row);
      if (Object.keys(vars).length === 0) {
        // No useful vars on this company — mark done so we don't
        // re-check it next call, but don't count as an update.
        markDone.run(new Date().toISOString(), clId);
        skippedEmpty++;
        continue;
      }

      try {
        await instantlyClient.updateLead(leadId, vars);
        markDone.run(new Date().toISOString(), clId);
        updated++;
      } catch (e) {
        errors++;
        if (errorSamples.length < 5) {
          errorSamples.push({
            leadId,
            message: e instanceof Error ? e.message : String(e),
          });
        }
        // Don't mark done — leave it for the next call to retry.
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // Re-query "remaining" instead of subtracting from remainingBefore.
  // Under force=true the simple subtraction undercounts — every row
  // is force-eligible, so remainingBefore is the FULL set (2825), and
  // (2825 - 1000) = 1825 even after we've processed 1000 of the
  // never-touched ones. The real "still needs work this loop" count
  // is "rows whose backfilled_at is NULL OR older than this run
  // started" — which the processed rows are no longer in.
  const remaining = (sqlite.prepare(remainingCountSql)
    .get(...remainingCountParams) as { c: number }).c;

  return NextResponse.json({
    ok: true,
    scanned: rows.length,
    updated,
    skippedEmpty,
    errors,
    errorSamples,
    remaining,
  });
}
