export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { getSessionUser } from "@/lib/get-session";
import {
  metaConfig, metaLeadsConfigured, metaCapiConfigured, sendCapiEvents, hashEmail,
} from "@/modules/integrations/lib/meta/client";
import { getKnownForms, drainMetaLeads, reconcileMetaLeads } from "@/modules/integrations/lib/meta/lead-ingest";
import { syncCapiStageEvents, drainCapiEvents } from "@/modules/integrations/lib/meta/capi";
import { ensureFacebookPipeline, getFacebookPipelineConfig } from "@/modules/integrations/lib/meta/pipedrive-push";

/**
 * Meta (Facebook / Instagram) integration status for the settings UI.
 *
 * Reports the two halves separately, because they're configured from different
 * places in Meta and either can work without the other:
 *   inbound  — Lead Ads webhook → the frame → Pipedrive   (needs a Meta App)
 *   outbound — CRM funnel events → Conversions API        (needs a dataset token)
 *
 * Never exposes secret values, only whether each is present.
 */

const WRITE_ROLES = ["owner", "marketing", "sales_manager"];

function count(sql: string, ...args: unknown[]): number {
  try {
    const r = sqlite.prepare(sql).get(...args) as Record<string, number> | undefined;
    const v = r ? Object.values(r)[0] : 0;
    return typeof v === "number" ? v : 0;
  } catch {
    return 0;
  }
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const c = metaConfig();
  const inboundReady = metaLeadsConfigured();
  const outboundReady = metaCapiConfigured();

  const base = (process.env.SHOPIFY_APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  const leadsTotal = count("SELECT COUNT(*) v FROM meta_leads");
  const leads7d = count("SELECT COUNT(*) v FROM meta_leads WHERE created_at >= datetime('now','-7 days')");
  const lastLead = (() => {
    try {
      return (sqlite.prepare("SELECT created_at FROM meta_leads ORDER BY created_at DESC LIMIT 1").get() as { created_at: string } | undefined)?.created_at ?? null;
    } catch { return null; }
  })();

  // What's still missing, in the order it needs doing.
  const missing: Array<{ key: string; label: string; where: string }> = [];
  if (!c.appSecret) {
    missing.push({
      key: "META_APP_SECRET", label: "App secret",
      where: "developers.facebook.com → your app → App settings → Basic → App secret (click Show).",
    });
  }
  if (!c.verifyToken) {
    missing.push({
      key: "META_VERIFY_TOKEN", label: "Webhook verify token",
      where: "You invent this one — any random string (e.g. jaxy_meta_7f3a9c). Put the SAME value in Railway and in Meta's webhook setup; they're compared to each other.",
    });
  }
  if (!c.pageToken) {
    missing.push({
      key: "META_PAGE_TOKEN", label: "Page access token",
      where: "business.facebook.com → Business settings → Users → System users → add/select a user → Generate new token → pick your app → tick leads_retrieval, pages_read_engagement, pages_manage_metadata, pages_show_list.",
    });
  }
  if (!c.capiToken) {
    missing.push({
      key: "META_CAPI_TOKEN", label: "Conversions API token",
      where:
        `If you followed Meta's "Send a CRM event" guide, you already have this: it's the access_token= value in the endpoint URL that page shows you (…/${c.datasetId}/events?access_token=THIS_PART). ` +
        "Otherwise: Events Manager → Data sources → your dataset → Settings → Conversions API → Generate access token.",
    });
  }

  return NextResponse.json({
    ok: true,
    configured: inboundReady || outboundReady,
    inbound: {
      ready: inboundReady,
      appSecret: !!c.appSecret,
      verifyToken: !!c.verifyToken,
      pageToken: !!c.pageToken,
      webhookUrl: base ? `${base}/api/v1/integrations/meta/webhooks` : null,
      knownForms: getKnownForms(),
      leadsTotal,
      leads7d,
      lastLeadAt: lastLead,
      byStatus: (() => {
        try { return sqlite.prepare("SELECT status, COUNT(*) n FROM meta_leads GROUP BY status").all(); } catch { return []; }
      })(),
      pipeline: getFacebookPipelineConfig(),
    },
    outbound: {
      ready: outboundReady,
      capiToken: !!c.capiToken,
      datasetId: c.datasetId,
      graphVersion: c.graphVersion,
      testEventCode: !!c.testEventCode,
      sent: count("SELECT COUNT(*) v FROM meta_capi_events WHERE status = 'sent'"),
      pending: count("SELECT COUNT(*) v FROM meta_capi_events WHERE status = 'pending'"),
      errored: count("SELECT COUNT(*) v FROM meta_capi_events WHERE status = 'error'"),
      byEvent: (() => {
        try { return sqlite.prepare("SELECT event_name, status, COUNT(*) n FROM meta_capi_events GROUP BY event_name, status").all(); } catch { return []; }
      })(),
      lastError: (() => {
        try {
          return (sqlite.prepare("SELECT error FROM meta_capi_events WHERE error IS NOT NULL ORDER BY created_at DESC LIMIT 1").get() as { error: string } | undefined)?.error ?? null;
        } catch { return null; }
      })(),
    },
    missing,
    canEdit: WRITE_ROLES.includes(user.role),
  });
}

/**
 * POST { action }
 *   test-event      { testEventCode, email? } — fire a Lead event at Test Events
 *   ensure-pipeline — provision the Facebook Leads pipeline in Pipedrive
 *   drain           — process any pending/errored leads now
 *   reconcile       — re-poll known forms for dropped webhooks
 *   capi-sync       — derive stage events and flush the CAPI queue
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!WRITE_ROLES.includes(user.role)) {
    return NextResponse.json({ error: "not permitted for your role" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  switch (body.action) {
    case "test-event": {
      const code = typeof body.testEventCode === "string" && body.testEventCode.trim()
        ? body.testEventCode.trim()
        : metaConfig().testEventCode;
      if (!code) {
        return NextResponse.json({ error: "A test event code is required — get one from Events Manager → Test Events." }, { status: 400 });
      }
      const em = hashEmail(typeof body.email === "string" && body.email ? body.email : "test@example.com");
      const result = await sendCapiEvents(
        [{
          event_name: "Lead",
          event_time: Math.floor(Date.now() / 1000),
          action_source: "system_generated",
          custom_data: { event_source: "crm", lead_event_source: "the frame" },
          user_data: em ? { em: [em] } : {},
        }],
        code,
      );
      return NextResponse.json({ ok: result.ok, result });
    }
    case "ensure-pipeline":
      return NextResponse.json({ ok: true, pipeline: await ensureFacebookPipeline() });
    case "drain":
      return NextResponse.json({ ok: true, result: await drainMetaLeads(25) });
    case "reconcile":
      return NextResponse.json({ ok: true, result: await reconcileMetaLeads(50) });
    case "capi-sync": {
      const { queued } = syncCapiStageEvents();
      const drain = await drainCapiEvents(200);
      return NextResponse.json({ ok: true, queued, drain });
    }
    default:
      return NextResponse.json({ error: `unknown action "${body.action}"` }, { status: 400 });
  }
}
