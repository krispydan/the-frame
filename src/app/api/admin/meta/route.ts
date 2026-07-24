export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import {
  metaConfig,
  metaLeadsConfigured,
  metaCapiConfigured,
  sendCapiEvents,
  hashEmail,
} from "@/modules/integrations/lib/meta/client";
import {
  drainMetaLeads,
  reconcileMetaLeads,
  processMetaLead,
  getKnownForms,
} from "@/modules/integrations/lib/meta/lead-ingest";
import { ensureFacebookPipeline, getFacebookPipelineConfig } from "@/modules/integrations/lib/meta/pipedrive-push";
import { syncCapiStageEvents, drainCapiEvents } from "@/modules/integrations/lib/meta/capi";

/**
 * Admin control surface for the Meta Lead Ads integration.
 *
 * GET  → config presence (no secrets) + lead/CAPI counts + pipeline + webhook URL.
 * POST { action }:
 *   ensure-pipeline   provision the Facebook Leads pipeline in Pipedrive
 *   drain             process still-'received' leads now
 *   reconcile         re-poll known forms (safety net / historical backfill)
 *   process           process one leadgen_id: { leadgenId }
 *   capi-sync         derive stage events from DB state + flush the queue
 *   test-event        send a Test Events ping: { testEventCode, email? }
 *
 * Auth: x-admin-key: jaxy2026.
 */

const VERSION = "v1-meta-admin";

export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const c = metaConfig();
  const leadStatus = sqlite.prepare("SELECT status, COUNT(*) n FROM meta_leads GROUP BY status").all() as Array<{ status: string; n: number }>;
  const capiStatus = sqlite.prepare("SELECT status, COUNT(*) n FROM meta_capi_events GROUP BY status").all() as Array<{ status: string; n: number }>;
  const capiByEvent = sqlite.prepare("SELECT event_name, status, COUNT(*) n FROM meta_capi_events GROUP BY event_name, status").all();
  const recentLeads = sqlite
    .prepare("SELECT leadgen_id, full_name, email, company_id, campaign_name, ad_name, status, created_at FROM meta_leads ORDER BY created_at DESC LIMIT 10")
    .all();
  const base = (process.env.SHOPIFY_APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");

  return NextResponse.json({
    ok: true,
    version: VERSION,
    config: {
      appSecret: !!c.appSecret,
      verifyToken: !!c.verifyToken,
      pageToken: !!c.pageToken,
      capiToken: !!c.capiToken,
      datasetId: c.datasetId,
      graphVersion: c.graphVersion,
      testEventCode: !!c.testEventCode,
      leadsConfigured: metaLeadsConfigured(),
      capiConfigured: metaCapiConfigured(),
    },
    webhookUrl: base ? `${base}/api/v1/integrations/meta/webhooks` : "(set SHOPIFY_APP_URL)",
    pipeline: getFacebookPipelineConfig(),
    knownForms: getKnownForms(),
    leads: { byStatus: leadStatus, recent: recentLeads },
    capi: { byStatus: capiStatus, byEvent: capiByEvent },
  });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = body.action as string | undefined;

  switch (action) {
    case "ensure-pipeline": {
      const config = await ensureFacebookPipeline();
      return NextResponse.json({ ok: true, pipeline: config });
    }
    case "drain": {
      const result = await drainMetaLeads(typeof body.limit === "number" ? body.limit : 25);
      return NextResponse.json({ ok: true, result });
    }
    case "reconcile": {
      const result = await reconcileMetaLeads(typeof body.perForm === "number" ? body.perForm : 50);
      return NextResponse.json({ ok: true, result });
    }
    case "process": {
      if (!body.leadgenId) return NextResponse.json({ error: "leadgenId required" }, { status: 400 });
      const result = await processMetaLead(String(body.leadgenId));
      return NextResponse.json({ ok: true, result });
    }
    case "capi-sync": {
      const { queued } = syncCapiStageEvents();
      const drain = await drainCapiEvents(200, typeof body.testEventCode === "string" ? body.testEventCode : undefined);
      return NextResponse.json({ ok: true, queued, drain });
    }
    case "test-event": {
      // Sends a single Lead event to the Test Events tab. Does not touch real data.
      const testCode = typeof body.testEventCode === "string" ? body.testEventCode : metaConfig().testEventCode;
      if (!testCode) return NextResponse.json({ error: "testEventCode required (Events Manager → Test Events)" }, { status: 400 });
      const em = hashEmail(typeof body.email === "string" ? body.email : "test@example.com");
      const result = await sendCapiEvents(
        [
          {
            event_name: "Lead",
            event_time: Math.floor(Date.now() / 1000),
            action_source: "system_generated",
            custom_data: { event_source: "crm", lead_event_source: "the frame" },
            user_data: em ? { em: [em] } : {},
          },
        ],
        testCode,
      );
      return NextResponse.json({ ok: result.ok, result });
    }
    default:
      return NextResponse.json({ error: `unknown action "${action}"` }, { status: 400 });
  }
}
