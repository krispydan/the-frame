export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import {
  getPipedriveConnectionStatus,
  isPipedriveConfigured,
  getPipedriveRedirectUri,
  pingPipedrive,
  listPipelines,
  listStages,
  listUsers,
} from "@/modules/sales/lib/pipedrive-client";

/**
 * GET /api/admin/pipedrive/status?key=jaxy2026
 *
 * Curl-friendly (key-gated, exempt from the login middleware) twin of
 * /api/v1/integrations/pipedrive/status. Returns config + connection health,
 * and when connected the pipelines / stages / active users (for wiring sync
 * config + picking Christina's owner_id).
 */
export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key") || req.headers.get("x-admin-key") || "";
  if (key !== "jaxy2026") {
    return NextResponse.json({ ok: false, error: "invalid admin key" }, { status: 401 });
  }

  const status = getPipedriveConnectionStatus();
  const out: Record<string, unknown> = {
    ok: true,
    configured: isPipedriveConfigured(),
    redirectUri: getPipedriveRedirectUri(),
    ...status,
  };

  if (status.connected) {
    const ping = await pingPipedrive();
    out.ping = ping;
    if (ping.ok) {
      try {
        const [pipelines, stages, users] = await Promise.all([listPipelines(), listStages(), listUsers()]);
        out.pipelines = pipelines.map((p) => ({ id: p.id, name: p.name }));
        out.stages = stages.map((s) => ({ id: s.id, name: s.name, pipeline_id: s.pipeline_id }));
        out.users = users.filter((u) => u.active_flag).map((u) => ({ id: u.id, name: u.name, email: u.email }));
      } catch (e) {
        out.stagesError = e instanceof Error ? e.message : String(e);
      }
    }
  }
  return NextResponse.json(out);
}
