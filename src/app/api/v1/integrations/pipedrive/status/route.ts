export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
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
import {
  seedAjmToPipedrive,
  backfillInterested,
  backfillOrderDeals,
  syncActivitiesToPipedrive,
  isSyncEnabled,
  setSyncEnabled,
  kickBackgroundRun,
  getAllRunStates,
  type RunTarget,
  PipedriveNotReadyError,
} from "@/modules/sales/lib/pipedrive-sync";
import { registerInboundWebhook, isInboundWebhookConfigured } from "@/modules/sales/lib/pipedrive-webhooks";

function count(sql: string): number {
  try {
    const r = sqlite.prepare(sql).get() as { n: number } | undefined;
    return r?.n ?? 0;
  } catch {
    return 0;
  }
}

function syncStats() {
  return {
    syncEnabled: isSyncEnabled(),
    webhookConfigured: isInboundWebhookConfigured(),
    ajmPushTagged: count("SELECT COUNT(*) n FROM companies WHERE tags LIKE '%ajm_pipedrive_push%'"),
    interested: count("SELECT COUNT(*) n FROM companies WHERE status IN ('interested','catalog_sent')"),
    wholesaleUnsynced: count(
      "SELECT COUNT(*) n FROM orders WHERE channel='shopify_wholesale' AND status!='cancelled' AND pipedrive_deal_id IS NULL",
    ),
    syncedOrgs: count("SELECT COUNT(*) n FROM companies WHERE pipedrive_org_id IS NOT NULL"),
    openDeals: count("SELECT COUNT(*) n FROM pipedrive_deals WHERE is_open=1"),
    wonDeals: count("SELECT COUNT(*) n FROM pipedrive_deals WHERE status='won'"),
  };
}

/**
 * GET /api/v1/integrations/pipedrive/status
 *
 * Connection health for the settings card. When connected, also returns the
 * pipelines + stages + active users (live from the API), the persisted
 * pipeline-ID map, the chosen deal owner, and local sync stats.
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
    syncStats: syncStats(),
    runs: getAllRunStates(),
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
 *  - { action: "disconnect" }                       — clear stored tokens
 *  - { action: "setup-pipelines" }                  — create the 3 pipelines/stages
 *  - { action: "set-owner", ownerId, ownerName }    — pick the default deal owner
 *  - { action: "register-webhook" }                 — create the inbound webhook + creds
 *  - { action: "preview", target }                  — dry-run a push, return counts.
 *      target = "seed-ajm" | "backfill-interested" | "backfill-orders"
 *
 * Heavy *real* runs (the actual seed/backfill writes) are deliberately NOT
 * exposed here — they can exceed the edge timeout and are run via the
 * key-gated /api/admin/pipedrive/sync endpoint (dry-run-first, chunkable).
 */
export async function POST(req: NextRequest) {
  let body: { action?: string; ownerId?: number; ownerName?: string; target?: string } = {};
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

      case "register-webhook": {
        const r = await registerInboundWebhook();
        return NextResponse.json({ ok: true, ...r });
      }

      case "set-sync-enabled": {
        setSyncEnabled(!!(body as { enabled?: boolean }).enabled);
        return NextResponse.json({ ok: true, syncEnabled: isSyncEnabled() });
      }

      case "run": {
        const target = (body as { target?: string }).target as RunTarget | undefined;
        if (!target || !["seed-ajm", "backfill-interested", "backfill-orders", "sync-activities", "remediate-faire"].includes(target)) {
          return NextResponse.json({ ok: false, error: `Unknown run target: ${target}` }, { status: 400 });
        }
        const r = kickBackgroundRun(target);
        return NextResponse.json({ ok: r.started, ...r });
      }

      case "preview": {
        if (body.target === "seed-ajm") {
          return NextResponse.json({ ok: true, preview: await seedAjmToPipedrive({ dryRun: true }) });
        }
        if (body.target === "backfill-interested") {
          return NextResponse.json({ ok: true, preview: await backfillInterested({ dryRun: true }) });
        }
        if (body.target === "backfill-orders") {
          return NextResponse.json({ ok: true, preview: await backfillOrderDeals({ dryRun: true }) });
        }
        if (body.target === "sync-activities") {
          return NextResponse.json({ ok: true, preview: await syncActivitiesToPipedrive({ dryRun: true }) });
        }
        if (body.target === "remediate-faire") {
          const { remediateFaireOrders } = await import("@/modules/orders/lib/faire-remediation");
          return NextResponse.json({ ok: true, preview: await remediateFaireOrders({ dryRun: true }) });
        }
        return NextResponse.json({ ok: false, error: `Unknown preview target: ${body.target}` }, { status: 400 });
      }

      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${body.action}` }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof PipedriveNotReadyError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 409 });
    }
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
