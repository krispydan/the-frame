export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET  /api/admin/jobs/health  → job-queue health snapshot
 * POST /api/admin/jobs/health  → reset stale 'running' jobs to 'pending'
 *
 * The worker's dequeue() bails (returns null) when >= 3 jobs are in
 * 'running' status. Server restarts mid-job leave rows stuck 'running'
 * forever; once 3 accumulate the ENTIRE queue jams and no pending job
 * ever runs (attempts stay 0). This surfaces + fixes that.
 *
 * POST body (optional): { staleMinutes?: number }  default 10
 *   Resets running jobs whose started_at is older than staleMinutes
 *   back to pending so the worker picks them up again.
 *
 * Auth: x-admin-key: jaxy2026
 */
function snapshot() {
  const byStatus = sqlite
    .prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status ORDER BY n DESC")
    .all();
  const runningDetail = sqlite
    .prepare(
      `SELECT type, id, attempts, started_at,
              ROUND((julianday('now') - julianday(started_at)) * 24 * 60, 1) AS running_minutes
         FROM jobs
        WHERE status = 'running'
        ORDER BY started_at ASC LIMIT 20`,
    )
    .all();
  const pendingByType = sqlite
    .prepare(
      `SELECT type, COUNT(*) AS n, MIN(created_at) AS oldest
         FROM jobs WHERE status = 'pending' GROUP BY type ORDER BY n DESC LIMIT 20`,
    )
    .all();
  return { byStatus, runningDetail, pendingByType };
}

export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, ...snapshot() });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { staleMinutes?: number } = {};
  try { body = await req.json(); } catch { /* empty OK */ }
  const staleMinutes = body.staleMinutes ?? 10;

  const before = snapshot();
  const res = sqlite
    .prepare(
      `UPDATE jobs
          SET status = 'pending', started_at = NULL
        WHERE status = 'running'
          AND (started_at IS NULL
               OR (julianday('now') - julianday(started_at)) * 24 * 60 > ?)`,
    )
    .run(staleMinutes);

  return NextResponse.json({
    ok: true,
    reset_to_pending: res.changes,
    stale_minutes: staleMinutes,
    before,
    after: snapshot(),
  });
}
