export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { runJob, setJobEnabled } from "@/modules/integrations/lib/cron/scheduler";
import { findJob } from "@/modules/integrations/lib/cron/registry";

/**
 * PATCH /api/v1/cron/jobs/{id}
 * Body: { enabled?: boolean }
 *
 * Toggle a job's enabled flag in cron_job_state. Used by the UI's
 * per-row enable switch.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!findJob(id)) return NextResponse.json({ error: `Unknown job: ${id}` }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  if (typeof body.enabled === "boolean") {
    await setJobEnabled(id, body.enabled);
  }
  return NextResponse.json({ ok: true });
}

/**
 * POST /api/v1/cron/jobs/{id}
 *
 * Manually trigger a single job — bypasses the schedule check but still
 * respects the lock + records a run row. Used by the UI's "Run now" button.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!findJob(id)) return NextResponse.json({ error: `Unknown job: ${id}` }, { status: 404 });

  const result = await runJob(id, "manual");
  const status = result.status === "ok" ? 200 : result.status === "skipped" ? 409 : 500;
  return NextResponse.json(result, { status });
}
