export const dynamic = "force-dynamic";
export const maxDuration = 600;
import { NextRequest, NextResponse } from "next/server";
import { runJob } from "@/modules/integrations/lib/cron/scheduler";
import { findJob } from "@/modules/integrations/lib/cron/registry";

/**
 * POST /api/admin/cron/run/{id}
 *
 * Admin-key-authenticated mirror of POST /api/v1/cron/jobs/{id}.
 * Same runJob semantics — bypasses schedule check, respects the
 * cron_job_state.in_progress lock, records a run row.
 *
 * Use case: post-incident resyncs where the operator needs to fire
 * specific jobs from outside the dashboard (e.g. via curl with
 * x-admin-key) without going through the session-cookie gate. The
 * UI's "Run now" button still hits /api/v1/cron/jobs/{id}.
 *
 * Header: x-admin-key: jaxy2026
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!findJob(id)) {
    return NextResponse.json({ error: `Unknown job: ${id}` }, { status: 404 });
  }
  const result = await runJob(id, "manual");
  const status =
    result.status === "ok" ? 200 : result.status === "skipped" ? 409 : 500;
  return NextResponse.json(result, { status });
}
