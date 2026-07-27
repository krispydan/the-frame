export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { verifyMetaSignature, metaVerifyToken } from "@/modules/integrations/lib/meta/client";
import { recordLeadgenEvent, processMetaLead } from "@/modules/integrations/lib/meta/lead-ingest";

/**
 * Meta Lead Ads webhook.
 *
 * GET  — subscription verification handshake. Meta calls this once with
 *        hub.mode=subscribe, hub.verify_token, hub.challenge; we echo the
 *        challenge back as plain text iff the verify token matches.
 *
 * POST — leadgen change notifications. Body shape:
 *        { object: "page", entry: [{ id, time, changes: [
 *            { field: "leadgen", value: { leadgen_id, page_id, form_id, created_time } }
 *        ] }] }
 *        The signed raw body is verified against META_APP_SECRET. Each
 *        leadgen_id is recorded (idempotent) and processed best-effort; we
 *        always 200 fast so Meta doesn't retry-storm on slow downstream calls.
 */

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  const expected = metaVerifyToken();

  // Meta's handshake: echo the challenge back when the token matches.
  if (mode === "subscribe" && expected && token === expected) {
    return new NextResponse(challenge ?? "", { status: 200, headers: { "content-type": "text/plain" } });
  }

  // Opening this URL in a browser sends no hub.* params. Rather than a bare
  // "Verification failed" (which reads like the endpoint is broken), say what
  // this is and whether it's ready for Meta to call. No secrets are exposed.
  if (!mode && !token && !challenge) {
    return NextResponse.json({
      endpoint: "Meta Lead Ads webhook",
      status: "live",
      verifyTokenConfigured: !!expected,
      message: expected
        ? "Ready. Enter this URL and your verify token in the Meta app's Webhooks settings, then subscribe to the 'leadgen' field."
        : "META_VERIFY_TOKEN is not set yet — add it in Railway before running Meta's webhook verification.",
      docs: "/settings/integrations/meta",
    });
  }

  // A real verification attempt that didn't match.
  return NextResponse.json(
    {
      error: "verification failed",
      reason: !expected
        ? "META_VERIFY_TOKEN is not configured on the server"
        : mode !== "subscribe"
          ? `expected hub.mode=subscribe, got "${mode ?? "nothing"}"`
          : "hub.verify_token did not match META_VERIFY_TOKEN",
    },
    { status: 403 },
  );
}

interface LeadgenChangeValue {
  leadgen_id?: string;
  page_id?: string;
  form_id?: string;
  created_time?: number;
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256");

  // Verify the payload is really from Meta. If META_APP_SECRET isn't set yet
  // we reject rather than trust an unsigned body.
  if (!verifyMetaSignature(rawBody, signature)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let body: { object?: string; entry?: Array<{ id?: string; changes?: Array<{ field?: string; value?: LeadgenChangeValue }> }> };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Collect leadgen entries and record them (idempotent) synchronously so we
  // never lose one, then process best-effort without blocking the 200.
  const leadgenIds: string[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "leadgen" || !change.value?.leadgen_id) continue;
      const v = change.value;
      recordLeadgenEvent({
        leadgenId: v.leadgen_id!,
        formId: v.form_id ?? null,
        pageId: v.page_id ?? entry.id ?? null,
        createdTime: v.created_time ? new Date(v.created_time * 1000).toISOString() : null,
      });
      leadgenIds.push(v.leadgen_id!);
    }
  }

  // Best-effort inline processing. The meta-leads-drain cron re-processes any
  // that fail or that a container restart interrupts (rows stay 'received').
  void (async () => {
    for (const id of leadgenIds) {
      try {
        await processMetaLead(id);
      } catch (e) {
        console.error("[meta/webhook] processMetaLead failed:", e instanceof Error ? e.message : e);
      }
    }
  })();

  return NextResponse.json({ ok: true, received: leadgenIds.length });
}
