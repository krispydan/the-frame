/**
 * PhoneBurner webhook receiver.
 *
 * Self-registers with the generic /api/webhooks/[provider] dispatcher
 * at module load (the dispatcher route side-effect imports this file).
 *
 * PhoneBurner webhook story (webhooksSettings.pdf in Daniel's downloads):
 *
 *   - **No HMAC signing, no custom-header field** in PB's webhook UI.
 *     The UI accepts only a URL. Workaround: the URL itself carries a
 *     secret path segment that we mint once via the bootstrap endpoint
 *     and verify on every inbound request.
 *
 *   - **Multiple webhook endpoints** in PB's UI: Call Begin, Call End,
 *     Contact Displayed, Email Unsubscribe, SMS Opt Out, Contact
 *     Activities (with sub-event checkboxes), Manual Trigger, plus
 *     per-disposition overrides. We expose ONE handler URL; Daniel
 *     pastes the same URL into each PB field (optionally with
 *     ?event=<hint> query param so the handler doesn't have to
 *     payload-sniff).
 *
 *   - **No documented per-delivery unique ID.** Idempotency is a
 *     content hash: sha256(event_type|call_id|contact_id|timestamp).
 *
 * Handler flow:
 *   1. Verify the URL secret against settings.phoneburner_webhook_token.
 *      Wrong/missing → 401 + audit row with token_valid=0.
 *   2. INSERT phoneburner_webhook_events keyed on the dedup hash.
 *      UNIQUE conflict → skip + return 200.
 *   3. Dispatch on event_type:
 *      - call_end → reuse ingestOneCall() (writes phoneburner_call_log,
 *        updates campaign_leads, writes activity_feed
 *        `phoneburner_call_completed`)
 *      - everything else → activity_feed entry only,
 *        event_type=phoneburner_<eventType>
 *   4. Mark handler_ok on the audit row.
 */
import { createHash } from "crypto";
import { sqlite } from "@/lib/db";
import { webhookRegistry, type WebhookPayload } from "@/modules/core/lib/webhooks";
import { ingestOneCall } from "./phoneburner-sync";
import {
  resolveByCampaignLeadId,
  resolveByPbContactId,
  resolveByPhone,
  type ResolveResult,
} from "./lead-resolution";

interface PbWebhookPayload {
  // PB seems to nest most fields directly on the body, but we can't
  // promise that without examples. Be liberal in what we accept.
  event_type?: string;
  event?: string;
  type?: string;
  call_id?: string;
  contact_id?: string;
  user_id?: string;       // round-tripped from contact create — our campaign_lead.id
  agent_id?: string;
  agent_email?: string;
  duration?: number;
  connected?: boolean | number;
  disposition?: string;
  disposition_label?: string;
  disposition_id?: string;
  notes?: string;
  recording_url?: string;
  phone?: string;
  email?: string;
  called_at?: string;
  timestamp?: string;
  [k: string]: unknown;
}

function getSetting(key: string): string | null {
  const row = sqlite
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

/**
 * Best-effort event-type extraction. Sources, in order:
 *   1. ?event=call_end query param (dispatcher route copies it into
 *      headers["x-pb-event"]). This is what the bootstrap endpoint
 *      bakes into the URLs Daniel pastes into PB.
 *   2. Payload event_type / event / type
 *   3. Heuristic: if call_id present, treat as call_end
 *   4. Fall back to literal "unknown" (still logged for inspection)
 */
function detectEventType(payload: WebhookPayload, body: PbWebhookPayload): string {
  const fromQuery = payload.headers["x-pb-event"];
  if (fromQuery) return fromQuery;
  if (body.event_type) return String(body.event_type);
  if (body.event) return String(body.event);
  if (body.type) return String(body.type);
  if (body.call_id || body.duration != null || body.disposition || body.disposition_label) {
    return "call_end";
  }
  return "unknown";
}

function dedupHash(eventType: string, body: PbWebhookPayload): string {
  const parts = [
    eventType,
    body.call_id ?? "",
    body.contact_id ?? "",
    body.user_id ?? "",
    body.timestamp ?? body.called_at ?? "",
    // Include disposition + phone in the hash because for non-call
    // events we won't have call_id; the combo still differentiates
    // distinct deliveries reasonably.
    body.disposition_id ?? body.disposition ?? "",
    body.phone ?? body.email ?? "",
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/**
 * Resolve a non-call event (no call_id) to a company_id via tiered
 * lookup. call_end events bypass this and go through ingestOneCall's
 * own resolver.
 */
function resolveNonCallEvent(body: PbWebhookPayload): ResolveResult | null {
  const r1 = resolveByCampaignLeadId(body.user_id ?? null);
  if (r1) return r1;
  const r2 = resolveByPbContactId(body.contact_id ?? null);
  if (r2) return r2;
  return resolveByPhone(body.phone ?? null);
}

function logToActivityFeed(opts: {
  companyId: string;
  eventType: string;
  body: PbWebhookPayload;
}): void {
  const { companyId, eventType, body } = opts;
  try {
    sqlite
      .prepare(
        `INSERT INTO activity_feed
         (id, event_type, module, entity_type, entity_id, data, user_id, created_at)
         VALUES (?, ?, 'sales', 'company', ?, ?, NULL, datetime('now'))`,
      )
      .run(
        crypto.randomUUID(),
        `phoneburner_${eventType}`,
        companyId,
        JSON.stringify({
          agent_id: body.agent_id ?? null,
          agent_email: body.agent_email ?? null,
          contact_id: body.contact_id ?? null,
          notes: body.notes ? String(body.notes).slice(0, 500) : null,
          timestamp: body.timestamp ?? body.called_at ?? null,
          // Keep the full event-specific shape so the renderer has
          // something to display for events we don't pretty-print yet.
          ...stripVerboseFields(body),
        }),
      );
  } catch (e) {
    console.error("[phoneburner-webhook] activity_feed insert failed:", e);
  }
}

function stripVerboseFields(body: PbWebhookPayload): Record<string, unknown> {
  // Drop fields that are huge or already captured at the top level —
  // keeps activity_feed.data compact for the prospect page renderer.
  const drop = new Set([
    "agent_id",
    "agent_email",
    "contact_id",
    "notes",
    "timestamp",
    "called_at",
    "recording_url",
    // and any internal-looking auth/url
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (drop.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Webhook handler. Called by the generic dispatcher at
 * /api/webhooks/phoneburner/[secret].
 */
async function handlePhoneBurnerWebhook(
  payload: WebhookPayload,
): Promise<{ ok: boolean; message?: string }> {
  const body = (payload.parsedBody ?? {}) as PbWebhookPayload;
  const eventType = detectEventType(payload, body);

  // 1. Token check. The dispatcher route sticks the secret it parsed
  //    from the URL on payload.headers["x-pb-webhook-secret"]
  //    (lowercased per Next.js normalization).
  const expected = getSetting("phoneburner_webhook_token");
  const provided =
    payload.headers["x-pb-webhook-secret"] ??
    payload.headers["X-PB-Webhook-Secret"] ??
    "";
  const tokenValid = !!expected && provided === expected;

  // 2. Audit-log INSERT keyed on dedup hash.
  const id = dedupHash(eventType, body);
  let isNewDelivery = true;
  try {
    sqlite
      .prepare(
        `INSERT INTO phoneburner_webhook_events
         (id, event_type, pb_call_id, pb_contact_id, frame_lead_id,
          payload, token_valid, handler_ok, handler_message, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, datetime('now'))`,
      )
      .run(
        id,
        eventType,
        body.call_id ?? null,
        body.contact_id ?? null,
        body.user_id ?? null,
        payload.body,
        tokenValid ? 1 : 0,
      );
  } catch (e) {
    if (/UNIQUE/i.test(e instanceof Error ? e.message : String(e))) {
      isNewDelivery = false;
    } else {
      console.error("[phoneburner-webhook] audit insert failed:", e);
    }
  }

  if (!tokenValid) {
    return { ok: false, message: "Invalid PhoneBurner webhook secret" };
  }
  if (!isNewDelivery) {
    return { ok: true, message: "Duplicate delivery — idempotent skip" };
  }

  // 3. Event dispatch.
  let message = "";
  try {
    if (eventType === "call_end") {
      // Reuse the same ingestion the polling cron uses.
      const outcome = ingestOneCall({
        id: String(body.call_id ?? ""),
        call_id: body.call_id ?? undefined,
        contact_id: body.contact_id ?? undefined,
        user_id: body.user_id ?? undefined,
        agent_id: body.agent_id ?? undefined,
        agent_email: body.agent_email ?? undefined,
        duration: typeof body.duration === "number" ? body.duration : undefined,
        connected: body.connected,
        disposition: body.disposition ?? undefined,
        disposition_id: body.disposition_id ?? undefined,
        disposition_label: body.disposition_label ?? undefined,
        notes: body.notes ?? undefined,
        recording_url: body.recording_url ?? undefined,
        phone: body.phone ?? undefined,
        called_at: body.called_at ?? body.timestamp ?? undefined,
      });
      message = `call_end ${outcome}`;
    } else {
      // Non-call events: just write to activity_feed if we can resolve
      // a company. Unmatched events get logged in the audit table only.
      const match = resolveNonCallEvent(body);
      if (match) {
        logToActivityFeed({
          companyId: match.companyId,
          eventType,
          body,
        });
        message = `${eventType} → company ${match.companyId}`;
      } else {
        message = `${eventType} unmatched (no company)`;
      }
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    sqlite
      .prepare(
        `UPDATE phoneburner_webhook_events SET handler_ok = 0, handler_message = ? WHERE id = ?`,
      )
      .run(errMsg, id);
    return { ok: false, message: errMsg };
  }

  sqlite
    .prepare(
      `UPDATE phoneburner_webhook_events SET handler_ok = 1, handler_message = ? WHERE id = ?`,
    )
    .run(message, id);

  return { ok: true, message };
}

// Self-register at module load. The generic dispatcher route imports
// this module via a side-effect import so registration fires before
// the first request.
webhookRegistry.register("phoneburner", handlePhoneBurnerWebhook);
