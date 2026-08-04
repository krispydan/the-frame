export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { listJobs } from "@/modules/integrations/lib/cron/scheduler";

/**
 * GET /api/admin/cron/jobs
 *
 * Admin-key mirror of GET /api/v1/cron/jobs (which is session-gated, so it's
 * unreachable from curl). Same payload: every registered job with its state
 * and recent runs.
 *
 * This exists because diagnosing a detached job — one that dispatches and then
 * fails somewhere the response never sees — otherwise means reading Railway
 * logs, and cron_runs already has the answer.
 *
 * Optional ?id= filters to one job.
 * Header: x-admin-key: jaxy2026
 */
export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const id = req.nextUrl.searchParams.get("id");
  const jobs = await listJobs({ recentRunCount: 8 });
  return NextResponse.json({ ok: true, jobs: id ? jobs.filter((j) => j.id === id) : jobs });
}
