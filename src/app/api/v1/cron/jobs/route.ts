export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { listJobs } from "@/modules/integrations/lib/cron/scheduler";

/**
 * GET /api/v1/cron/jobs
 *
 * Returns every job in the registry plus its current state and the last
 * 5 runs each. UI consumes this to render the cron dashboard.
 */
export async function GET() {
  const jobs = await listJobs({ recentRunCount: 5 });
  return NextResponse.json({ jobs });
}
