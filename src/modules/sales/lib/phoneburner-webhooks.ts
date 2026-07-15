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
  resolveByCompanyId,
  resolveByPbContactId,
  resolveByPhone,
  type ResolveResult,
} from "./lead-resolution";
import { progressCompanyStatus, type CompanyStatus } from "./status-progression";
import { enqueueCallTranscription, enqueueFollowupSummary } from "./status-sync";
import { updatePerson } from "./pipedrive-client";

/**
 * Map a PhoneBurner disposition label to a companies.status value, or
 * null if the disposition doesn't change pipeline state (No Answer,
 * Busy Phone, Left Message → still in the calling queue).
 *
 * Per Daniel 2026-06-18:
 *   Set Appointment   → interested (they requested the catalog)
 *   Not Interested    → not_interested
 *   Do Not Call       → not_interested (kept off the dial list via
 *                       disposition_label preserved on call_log; no
 *                       separate DNC enum state exists yet)
 *
 * Matching is case-insensitive + space-tolerant so minor PB-side label
 * tweaks ("Set Appt." etc.) don't silently break the pipeline plumbing.
 */
function dispositionToStatus(disposition: string | null | undefined): CompanyStatus | null {
  if (!disposition) return null;
  const norm = disposition.trim().toLowerCase().replace(/[\s.\-_]+/g, " ");
  if (norm.startsWith("set appointment") || norm.startsWith("set appt")) {
    return "interested";
  }
  if (norm.startsWith("not interested")) {
    return "not_interested";
  }
  if (norm.startsWith("do not call") || norm === "dnc") {
    return "not_interested";
  }
  return null;
}

interface PbWebhookPayload {
  // Confirmed shape from a real call_end payload (2026-06-18):
  event_type?: string;
  event?: string;
  type?: string;
  status?: string;         // disposition label, e.g. "No Answer"
  call_id?: number | string;
  ds_id?: number | string;
  duration?: number;
  connected?: number | string | boolean;
  start_time?: string;
  end_time?: string;
  recording_url?: string;
  recording_link?: string;
  direction?: string;
  call_notes?: Array<string | { note?: string }>;
  outbound_caller_id?: string;
  contact?: {
    user_id?: string;       // PB's contact id
    lead_id?: string;
    external_id?: string;
    phone?: string;
    phones?: Array<{ number?: string; phone_type?: string }>;
    primary_email?: string;
    first_name?: string;
    last_name?: string;
  };
  agent?: {
    user_id?: string;
    email?: string;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  owner?: { owner_id?: string | number; email?: string };
  custom_fields?: Record<string, string | number | null | undefined>;
  folder?: { id?: string | number; name?: string };
  // Lingering aliases from older docs (we keep the keys so existing
  // tests against synthetic payloads keep working):
  call_end?: unknown;
  disposition?: string;
  disposition_label?: string;
  disposition_id?: string;
  agent_id?: string;
  agent_email?: string;
  notes?: string;
  phone?: string;
  email?: string;
  called_at?: string;
  timestamp?: string;
  user_id?: string;
  contact_id?: string;
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

/** Pull values from the variable PB payload shape — top-level OR nested. */
function pbCallId(body: PbWebhookPayload): string | null {
  if (body.call_id != null) return String(body.call_id);
  return null;
}
function pbContactUserId(body: PbWebhookPayload): string | null {
  return body.contact?.user_id ?? body.contact_id ?? null;
}
function pbContactPhone(body: PbWebhookPayload): string | null {
  if (body.contact?.phone) return String(body.contact.phone);
  const phones = body.contact?.phones;
  if (Array.isArray(phones) && phones[0]?.number) return String(phones[0].number);
  return body.phone ?? null;
}
function pbCustomField(body: PbWebhookPayload, name: string): string | null {
  const v = body.custom_fields?.[name];
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function pbAgentEmail(body: PbWebhookPayload): string | null {
  return body.agent?.email ?? body.agent_email ?? null;
}
function pbAgentId(body: PbWebhookPayload): string | null {
  return body.agent?.user_id ?? body.agent_id ?? null;
}
function pbDisposition(body: PbWebhookPayload): string | null {
  return body.status ?? body.disposition_label ?? body.disposition ?? null;
}
function pbConnected(body: PbWebhookPayload): boolean {
  const v = body.connected;
  if (v == null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return String(v).trim() === "1" || String(v).trim().toLowerCase() === "true";
}
function pbNotes(body: PbWebhookPayload): string | null {
  if (typeof body.notes === "string" && body.notes.trim()) return body.notes;
  const arr = body.call_notes;
  if (Array.isArray(arr) && arr.length) {
    return arr
      .map((n) => (typeof n === "string" ? n : n?.note ?? ""))
      .filter(Boolean)
      .join("\n") || null;
  }
  return null;
}

function dedupHash(eventType: string, body: PbWebhookPayload): string {
  const parts = [
    eventType,
    pbCallId(body) ?? "",
    pbContactUserId(body) ?? "",
    body.user_id ?? pbCustomField(body, "Frame Lead ID") ?? "",
    body.start_time ?? body.timestamp ?? body.called_at ?? "",
    pbDisposition(body) ?? "",
    pbContactPhone(body) ?? body.email ?? "",
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/**
 * Resolve a non-call event to a company_id. Priority:
 *   1. custom_fields["Company ID"]  — our companies.id round-trip
 *   2. custom_fields["Frame Lead ID"] — our campaign_leads.id round-trip
 *   3. body.user_id (legacy round-trip on contact)
 *   4. PB contact user_id ↔ phoneburner_contact_id
 *   5. Phone digits
 */
function resolveEvent(body: PbWebhookPayload): ResolveResult | null {
  const companyIdCF = pbCustomField(body, "Company ID");
  const r1 = resolveByCompanyId(companyIdCF);
  if (r1) return r1;
  const frameLeadIdCF = pbCustomField(body, "Frame Lead ID");
  const r2 = resolveByCampaignLeadId(frameLeadIdCF ?? body.user_id ?? null);
  if (r2) return r2;
  const r3 = resolveByPbContactId(pbContactUserId(body));
  if (r3) return r3;
  return resolveByPhone(pbContactPhone(body));
}

/** True for PhoneBurner events that represent an edit to the contact record
 *  (so we sync fields back), not a passive event like "contact displayed". PB's
 *  exact event string varies by account config, so match on intent. */
function isContactUpdateEvent(eventType: string): boolean {
  return /contact/i.test(eventType) && /(updat|edit|activit|chang)/i.test(eventType);
}

function validEmail(e: string | null | undefined): string | null {
  const s = (e ?? "").trim().toLowerCase();
  return s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/** Email the agent set on the PB contact (nested or flat shape). */
function pbContactEmail(body: PbWebhookPayload): string | null {
  return body.contact?.primary_email ?? body.email ?? null;
}

/**
 * Writeback: when an agent edits a contact's email in PhoneBurner, propagate it
 * to the frame (contacts + campaign_leads) and to the Pipedrive person — so the
 * frame stays the source of truth and a later push doesn't clobber the fix.
 * Targets the company's primary contact (our AJM cohort is one-contact-per-
 * company). No-ops when the email is missing/invalid/unchanged.
 */
async function syncContactWriteback(match: ResolveResult, body: PbWebhookPayload): Promise<string> {
  const newEmail = validEmail(pbContactEmail(body));
  if (!newEmail) return "no valid email in payload — nothing to sync";
  const changes: string[] = [];

  // 1. Frame primary contact.
  const contact = sqlite
    .prepare("SELECT id, email FROM contacts WHERE company_id = ? ORDER BY is_primary DESC, created_at ASC LIMIT 1")
    .get(match.companyId) as { id: string; email: string | null } | undefined;
  if (contact) {
    if ((contact.email ?? "").trim().toLowerCase() !== newEmail) {
      sqlite.prepare("UPDATE contacts SET email = ?, updated_at = datetime('now') WHERE id = ?").run(newEmail, contact.id);
      changes.push("frame contact");
    }
  } else {
    // No contact row yet — create one so the email has a home.
    sqlite
      .prepare(
        `INSERT INTO contacts (id, company_id, email, is_primary, source, created_at, updated_at)
         VALUES (?, ?, ?, 1, 'phoneburner_writeback', datetime('now'), datetime('now'))`,
      )
      .run(crypto.randomUUID(), match.companyId, newEmail);
    changes.push("frame contact (created)");
  }

  // 2. campaign_leads row, if this event resolved to one.
  if (match.campaignLeadId) {
    const cl = sqlite.prepare("SELECT email FROM campaign_leads WHERE id = ?").get(match.campaignLeadId) as { email: string | null } | undefined;
    if (cl && (cl.email ?? "").trim().toLowerCase() !== newEmail) {
      sqlite.prepare("UPDATE campaign_leads SET email = ?, updated_at = datetime('now') WHERE id = ?").run(newEmail, match.campaignLeadId);
      changes.push("campaign_lead");
    }
  }

  // 3. Pipedrive person (email is an array of values on the person).
  const personId = (sqlite.prepare("SELECT pipedrive_person_id AS id FROM companies WHERE id = ?").get(match.companyId) as { id: number | null } | undefined)?.id ?? null;
  if (personId) {
    try {
      await updatePerson(personId, { email: [newEmail] });
      changes.push("pipedrive person");
    } catch (e) {
      changes.push(`pipedrive failed(${e instanceof Error ? e.message.slice(0, 60) : "err"})`);
    }
  }

  return changes.length ? `email → ${newEmail}: ${changes.join(", ")}` : "email unchanged";
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
  const auditCallId = pbCallId(body);
  const auditContactId = pbContactUserId(body);
  const auditFrameLeadId =
    pbCustomField(body, "Frame Lead ID") ?? body.user_id ?? null;
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
        auditCallId,
        auditContactId,
        auditFrameLeadId,
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
      // PB's actual call_end payload puts the disposition on `status`,
      // agent fields nested under `agent`, and our companies.id /
      // campaign_leads.id round-tripped through the custom_fields
      // we set on push. Flatten into the shape ingestOneCall expects.
      const disposition = pbDisposition(body);
      const callId = pbCallId(body) ?? "";

      // Resolve with custom_fields["Company ID"] FIRST — pass the
      // result to ingestOneCall via preResolved so it doesn't fall
      // back to its own resolver (which would walk PB's contact_id
      // and miss the cleaner match path).
      const match = resolveEvent(body);
      const outcome = ingestOneCall(
        {
          id: callId,
          call_id: callId,
          contact_id: pbContactUserId(body) ?? undefined,
          user_id: match?.campaignLeadId ?? auditFrameLeadId ?? undefined,
          agent_id: pbAgentId(body) ?? undefined,
          agent_email: pbAgentEmail(body) ?? undefined,
          duration: typeof body.duration === "number" ? body.duration : undefined,
          connected: pbConnected(body),
          disposition: disposition ?? undefined,
          disposition_label: disposition ?? undefined,
          notes: pbNotes(body) ?? undefined,
          recording_url: body.recording_url ?? undefined,
          phone: pbContactPhone(body) ?? undefined,
          called_at: body.start_time ?? body.end_time ?? body.timestamp ?? undefined,
        },
        { preResolved: match },
      );
      message = `call_end ${outcome} disposition=${disposition ?? "(none)"}`;

      // Reverse loop: if this contact is on a rep's Pipedrive-driven call
      // list, close or reschedule the stamped Pipedrive activity + tidy
      // the folder. Best-effort, independent of pipeline progression.
      try {
        const { handleCallActivityFeedback } = await import("./pipedrive-call-sync");
        const dur = typeof body.duration === "number" ? Math.round(body.duration) : null;
        await handleCallActivityFeedback(pbContactUserId(body), disposition, dur);
      } catch (e) {
        console.error("[phoneburner-webhook] activity feedback failed:", e);
      }

      // Pipeline progression — if the disposition implies a status
      // change (Set Appointment → interested, Not Interested / Do Not
      // Call → not_interested), upgrade the company. progressCompanyStatus
      // is forward-only, so re-firing the same disposition is a no-op,
      // and a company already at "customer" or further along is never
      // downgraded.
      let firstInterestedEdge = false;
      const targetStatus = dispositionToStatus(disposition);
      if (targetStatus && match?.companyId) {
        try {
          const r = progressCompanyStatus(match.companyId, targetStatus, { source: "phoneburner" });
          if (r.updated) {
            message += ` status=${r.from ?? "?"}→${r.to}`;
            // Forward edge into 'interested' only — so re-asserting the
            // same disposition doesn't re-fire.
            if (r.to === "interested" && disposition) {
              firstInterestedEdge = true;
              // Always transcribe + save the recording for interested calls,
              // independent of the AI-enrichment flag — good data on file.
              try { enqueueCallTranscription(callId); } catch (e) {
                console.error("[phoneburner-webhook] enqueue transcription failed:", e);
              }
              // The Slack appointment-set notification is now sent by the
              // enrichment job (sales.enrich_interested_lead, enqueued via
              // the status fan-out) AFTER the AI runs, so it carries the
              // full call context in a single message.
            }
          } else {
            message += ` status=${r.from ?? "?"}(no-progress)`;
          }
        } catch (e) {
          console.error("[phoneburner-webhook] progressCompanyStatus failed:", e);
        }
      }

      // Follow-up (repeat) calls → transcribe + summarize the transcript
      // to the Pipedrive deal note. The FIRST interested call gets full
      // enrichment instead, so skip it here. Connected calls only; the job
      // self-skips when there's no open deal / no transcript.
      if (match?.companyId && pbConnected(body) && !firstInterestedEdge) {
        try { enqueueFollowupSummary(callId); } catch (e) {
          console.error("[phoneburner-webhook] enqueue followup summary failed:", e);
        }
      }
    } else {
      // Non-call events: write to activity_feed if we can resolve a company.
      // Unmatched events get logged in the audit table only.
      const match = resolveEvent(body);
      if (match) {
        // Contact edits (email change etc.) → sync the field back to the frame
        // + Pipedrive so the frame stays source of truth. Passive events
        // (e.g. contact displayed) are logged only, never written back.
        if (isContactUpdateEvent(eventType)) {
          const synced = await syncContactWriteback(match, body);
          message = `${eventType} → company ${match.companyId}; writeback: ${synced}`;
        } else {
          message = `${eventType} → company ${match.companyId}`;
        }
        logToActivityFeed({
          companyId: match.companyId,
          eventType,
          body,
        });
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
