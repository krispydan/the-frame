export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { tick } from "@/modules/integrations/lib/cron/scheduler";

/**
 * POST/GET /api/v1/cron/tick
 *
 * Heartbeat endpoint hit by ONE Railway cron service every minute.
 * Returns immediately with the list of jobs that ran (or skipped).
 *
 * Idempotent — concurrent ticks are guarded per-job via the
 * cron_job_state.in_progress lock.
 */
async function handle(req: NextRequest) {
  const nowParam = req.nextUrl.searchParams.get("now");
  const now = nowParam ? new Date(nowParam) : new Date();
  if (Number.isNaN(now.getTime())) {
    return NextResponse.json({ error: "Invalid `now` parameter" }, { status: 400 });
  }

  try {
    const result = await tick(now);
    return NextResponse.json({
      ok: true,
      tickedAt: now.toISOString(),
      ranJobs: result.ranJobs,
      skipped: result.skipped,
    });
  } catch (e) {
    return NextResponse.json({
      error: e instanceof Error ? e.message : "Tick failed",
    }, { status: 500 });
  }
}

export async function POST(req: NextRequest) { return handle(req); }
export async function GET(req: NextRequest)  { return handle(req); }
