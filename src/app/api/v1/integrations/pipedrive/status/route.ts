export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import {
  getPipedriveConnectionStatus,
  isPipedriveConfigured,
  getPipedriveRedirectUri,
  pingPipedrive,
  listPipelines,
  listStages,
} from "@/modules/sales/lib/pipedrive-client";

/**
 * GET /api/v1/integrations/pipedrive/status
 *
 * Connection health for the settings card. When connected, also returns the
 * pipelines + stages so their IDs can be wired into the sync config.
 */
export async function GET() {
  const configured = isPipedriveConfigured();
  const status = getPipedriveConnectionStatus();
  const out: Record<string, unknown> = {
    configured,
    redirectUri: getPipedriveRedirectUri(),
    ...status,
  };

  if (status.connected) {
    const ping = await pingPipedrive();
    out.ping = ping;
    if (ping.ok) {
      try {
        const [pipelines, stages] = await Promise.all([listPipelines(), listStages()]);
        out.pipelines = pipelines.map((p) => ({ id: p.id, name: p.name }));
        out.stages = stages.map((s) => ({ id: s.id, name: s.name, pipeline_id: s.pipeline_id }));
      } catch (e) {
        out.stagesError = e instanceof Error ? e.message : String(e);
      }
    }
  }
  return NextResponse.json(out);
}
