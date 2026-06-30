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
  disconnectPipedrive,
} from "@/modules/sales/lib/pipedrive-client";
import {
  ensurePipelines,
  getPipelineConfig,
  setPipedriveOwner,
  getPipedriveOwner,
} from "@/modules/sales/lib/pipedrive-setup";

/**
 * GET /api/v1/integrations/pipedrive/status
 *
 * Connection health for the settings card. When connected, also returns the
 * pipelines + stages + active users (live from the API), the persisted
 * pipeline-ID map, and the chosen deal owner.
 */
export async function GET() {
  const configured = isPipedriveConfigured();
  const status = getPipedriveConnectionStatus();
  const out: Record<string, unknown> = {
    configured,
    redirectUri: getPipedriveRedirectUri(),
    ...status,
    pipelineConfig: getPipelineConfig(),
    owner: getPipedriveOwner(),
  };

  if (status.connected) {
    const ping = await pingPipedrive();
    out.ping = ping;
    if (ping.ok) {
      try {
        const [pipelines, stages, users] = await Promise.all([listPipelines(), listStages(), listUsers()]);
        out.pipelines = pipelines.map((p) => ({ id: p.id, name: p.name }));
        out.stages = stages.map((s) => ({ id: s.id, name: s.name, pipeline_id: s.pipeline_id }));
        out.users = users
          .filter((u) => u.active_flag)
          .map((u) => ({ id: u.id, name: u.name, email: u.email }));
      } catch (e) {
        out.stagesError = e instanceof Error ? e.message : String(e);
      }
    }
  }
  return NextResponse.json(out);
}

/**
 * POST /api/v1/integrations/pipedrive/status
 *
 * Actions for the settings detail page:
 *  - { action: "disconnect" }                     — clear stored tokens
 *  - { action: "setup-pipelines" }                — create the 3 pipelines/stages
 *  - { action: "set-owner", ownerId, ownerName }  — pick the default deal owner
 */
export async function POST(req: NextRequest) {
  let body: { action?: string; ownerId?: number; ownerName?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }

  try {
    switch (body.action) {
      case "disconnect":
        disconnectPipedrive();
        return NextResponse.json({ ok: true });

      case "setup-pipelines": {
        const config = await ensurePipelines();
        return NextResponse.json({ ok: true, pipelineConfig: config });
      }

      case "set-owner": {
        if (!body.ownerId) {
          return NextResponse.json({ ok: false, error: "ownerId is required" }, { status: 400 });
        }
        setPipedriveOwner(body.ownerId, body.ownerName);
        return NextResponse.json({ ok: true, owner: getPipedriveOwner() });
      }

      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${body.action}` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
