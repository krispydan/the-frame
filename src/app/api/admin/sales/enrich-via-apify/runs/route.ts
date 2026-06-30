export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET /api/admin/sales/enrich-via-apify/runs
 *
 * Returns recent Apify enrichment batches with their final stats.
 * Useful because batches > 100 dispatch async (fire-and-forget to
 * avoid Cloudflare's 100s edge timeout), so the HTTP response
 * doesn't carry the completion stats.
 *
 * Optional params:
 *   ?limit=N   how many runs to return (default 20, max 100)
 *   ?status=running,completed  filter by status
 *
 * Auth: x-admin-key
 */
export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Math.min(
    100,
    Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10) || 20),
  );
  const statusCsv = url.searchParams.get("status");
  const statuses = statusCsv
    ? statusCsv.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const where: string[] = [];
  const params: unknown[] = [];
  if (statuses && statuses.length > 0) {
    where.push(`status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const rows = sqlite
    .prepare(
      `SELECT id, started_at, completed_at, status,
              limit_requested, tier_filter, status_filter,
              force_flag, dry_run,
              companies_attempted, phones_added,
              permanently_closed_marked, hours_updated,
              no_match, low_confidence_skipped,
              errors_count, errors_sample, error_message,
              CASE WHEN completed_at IS NOT NULL
                THEN (julianday(completed_at) - julianday(started_at)) * 86400
                ELSE NULL
              END AS duration_seconds
         FROM apify_enrichment_runs
         ${whereSql}
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all(...params, limit) as Array<Record<string, unknown>>;

  // Parse errors_sample JSON for readability
  for (const r of rows) {
    if (typeof r.errors_sample === "string" && r.errors_sample) {
      try {
        r.errors_sample = JSON.parse(r.errors_sample);
      } catch {
        /* leave as string */
      }
    }
  }

  // Quick aggregate over the returned window
  const totals = rows.reduce(
    (acc, r) => ({
      attempted: acc.attempted + Number(r.companies_attempted || 0),
      phones_added: acc.phones_added + Number(r.phones_added || 0),
      closed: acc.closed + Number(r.permanently_closed_marked || 0),
      no_match: acc.no_match + Number(r.no_match || 0),
      low_conf: acc.low_conf + Number(r.low_confidence_skipped || 0),
      errors: acc.errors + Number(r.errors_count || 0),
    }),
    { attempted: 0, phones_added: 0, closed: 0, no_match: 0, low_conf: 0, errors: 0 },
  );

  return NextResponse.json({
    ok: true,
    rows,
    totals_in_window: totals,
    note: "errors_sample contains up to 5 errors from a failed batch as a JSON array of {company_id, reason}. duration_seconds is null while a run is still in progress.",
  });
}
