/**
 * Instantly.ai webhook receiver.
 *
 * Self-registers with the generic /api/webhooks/[provider] dispatcher
 * at module load (see bottom of this file). The dispatcher route
 * imports this module via a side-effect import to trigger the
 * registration.
 *
 * Instantly's webhook story (see developer.instantly.ai):
 *
 *   - No HMAC signing. Instead, the webhook registration accepts a
 *     `headers` field that's injected on every delivery. We mint a
 *     random token at bootstrap, store it in settings.instantly_webhook_token,
 *     ship it as X-Webhook-Token, and verify on every inbound request.
 *
 *   - No per-delivery unique ID in the payload. We compute an
 *     idempotency hash from event_type|lead_email|campaign_id|timestamp
 *     and use it as the PK of instantly_webhook_events. Retries fail
 *     INSERT silently → free dedup.
 *
 *   - Event taxonomy (per developer.instantly.ai/guides/webhook-events):
 *     email_sent, email_opened, email_link_clicked, reply_received,
 *     email_bounced, lead_unsubscribed, lead_neutral, lead_interested,
 *     lead_not_interested, lead_out_of_office, lead_wrong_person,
 *     lead_meeting_booked, lead_meeting_completed, lead_no_show,
 *     lead_closed, account_error, campaign_completed,
 *     supersearch_enrichment_completed.
 *
 * Handler flow:
 *   1. Verify X-Webhook-Token. Reject 401 if missing/wrong, but still
 *      log the attempt to instantly_webhook_events for audit.
 *   2. INSERT into instantly_webhook_events on the dedup hash. On
 *      unique-conflict → return 200, do nothing else.
 *   3. Resolve lead_email → company_id via tiered lookup.
 *   4. Update campaign_leads (status, timestamp, reply_text) where applicable.
 *   5. Insert one row into activity_feed for the prospect timeline.
 *   6. Stamp instantly_webhook_events.handler_ok / handler_message.
 */
import { createHash } from "crypto";
import { sqlite } from "@/lib/db";
import { webhookRegistry, type WebhookPayload } from "@/modules/core/lib/webhooks";
import { progressCompanyStatus, type CompanyStatus } from "./status-progression";

interface InstantlyPayload {
  event_type?: string;
  timestamp?: string;
  workspace?: string;
  campaign_id?: string;
  campaign_name?: string;
  lead_email?: string;
  email_account?: string;
  step?: number;
  variant?: number;
  email_id?: string;
  email_subject?: string;
  email_text?: string;
  reply_text_snippet?: string;
  reply_subject?: string;
  reply_text?: string;
  reply_html?: string;
  [k: string]: unknown;
}

function getSetting(key: string): string | null {
  const row = sqlite
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

/**
 * Dedup hash: sha256(eventType|leadEmail|campaignId|timestamp). If
 * Instantly retries the same delivery (same wall-clock timestamp, same
 * recipient, same event), the hash collides and our PK insert fails.
 */
function dedupHash(p: InstantlyPayload): string {
  const parts = [
    p.event_type ?? "",
    p.lead_email ?? "",
    p.campaign_id ?? "",
    p.timestamp ?? "",
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/**
 * Resolve an Instantly lead email to a company_id. Tries three sources
 * in order of confidence. Returns null if nothing matches — Christina
 * sometimes adds leads in Instantly that we never imported, so a miss
 * is expected, not an error.
 */
function resolveCompanyId(opts: {
  leadEmail: string | null;
  instantlyCampaignId: string | null;
}): { companyId: string; campaignLeadId: string | null } | null {
  const { leadEmail, instantlyCampaignId } = opts;
  if (!leadEmail) return null;
  const email = leadEmail.trim().toLowerCase();
  if (!email) return null;

  // 1. campaign_leads join — strongest signal when we have both.
  if (instantlyCampaignId) {
    const row = sqlite
      .prepare(
        `SELECT cl.id, cl.company_id
           FROM campaign_leads cl
           JOIN campaigns c ON c.id = cl.campaign_id
          WHERE c.instantly_campaign_id = ?
            AND lower(cl.email) = ?
          LIMIT 1`,
      )
      .get(instantlyCampaignId, email) as { id: string; company_id: string } | undefined;
    if (row) return { companyId: row.company_id, campaignLeadId: row.id };
  }

  // 2. campaign_leads by email across any campaign.
  const clRow = sqlite
    .prepare(
      `SELECT id, company_id FROM campaign_leads
        WHERE lower(email) = ? AND company_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(email) as { id: string; company_id: string } | undefined;
  if (clRow) return { companyId: clRow.company_id, campaignLeadId: clRow.id };

  // 3. contacts table.
  const contactRow = sqlite
    .prepare(
      `SELECT company_id FROM contacts
        WHERE lower(email) = ? AND company_id IS NOT NULL
        LIMIT 1`,
    )
    .get(email) as { company_id: string } | undefined;
  if (contactRow) return { companyId: contactRow.company_id, campaignLeadId: null };

  // 4. companies.email itself.
  const compRow = sqlite
    .prepare(
      `SELECT id FROM companies WHERE lower(email) = ? LIMIT 1`,
    )
    .get(email) as { id: string } | undefined;
  if (compRow) return { companyId: compRow.id, campaignLeadId: null };

  return null;
}

/**
 * Map an Instantly event_type to a (campaign_leads.status, timestampColumn)
 * pair. Returns null if the event doesn't change campaign_leads state
 * (link clicks, lead label changes, etc. — those go to activity_feed only).
 */
function statusUpdateFor(eventType: string): { status: string; tsCol: string | null } | null {
  switch (eventType) {
    case "email_sent":         return { status: "sent",         tsCol: "sent_at" };
    case "email_opened":       return { status: "opened",       tsCol: "opened_at" };
    case "reply_received":     return { status: "replied",      tsCol: "replied_at" };
    case "email_bounced":      return { status: "bounced",      tsCol: null };
    case "lead_unsubscribed":  return { status: "unsubscribed", tsCol: null };
    default: return null;
  }
}

function stampCampaignLead(opts: {
  campaignLeadId: string;
  eventType: string;
  payload: InstantlyPayload;
}): void {
  const { campaignLeadId, eventType, payload } = opts;
  const update = statusUpdateFor(eventType);
  if (!update) return;

  // Build SET clause dynamically — status always, timestamp if available,
  // reply_text on reply events.
  const fields: string[] = ["status = ?"];
  const values: unknown[] = [update.status];
  if (update.tsCol) {
    fields.push(`${update.tsCol} = ?`);
    values.push(payload.timestamp ?? new Date().toISOString());
  }
  if (eventType === "reply_received") {
    const replyBody = (payload.reply_text || payload.reply_text_snippet || "").toString();
    if (replyBody) {
      fields.push("reply_text = ?");
      // Cap at 4KB to keep the DB row reasonable — full reply lives in
      // instantly_webhook_events.payload anyway.
      values.push(replyBody.slice(0, 4096));
    }
  }
  values.push(campaignLeadId);

  sqlite
    .prepare(`UPDATE campaign_leads SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
}

function logToActivityFeed(opts: {
  companyId: string;
  eventType: string;
  payload: InstantlyPayload;
}): void {
  const { companyId, eventType, payload } = opts;
  try {
    sqlite
      .prepare(
        `INSERT INTO activity_feed
         (id, event_type, module, entity_type, entity_id, data, user_id, created_at)
         VALUES (?, ?, 'sales', 'company', ?, ?, NULL, datetime('now'))`,
      )
      .run(
        crypto.randomUUID(),
        `instantly_${eventType}`,
        companyId,
        JSON.stringify({
          campaign_id: payload.campaign_id ?? null,
          campaign_name: payload.campaign_name ?? null,
          lead_email: payload.lead_email ?? null,
          step: payload.step ?? null,
          variant: payload.variant ?? null,
          email_subject: payload.email_subject ?? null,
          email_account: payload.email_account ?? null,
          reply_snippet:
            (payload.reply_text || payload.reply_text_snippet || "")
              .toString()
              .slice(0, 500) || null,
          timestamp: payload.timestamp ?? null,
        }),
      );
  } catch (e) {
    console.error("[instantly-webhook] activity_feed insert failed:", e);
  }
}

/**
 * The handler the generic dispatcher invokes. Returns the result shape
 * the dispatcher expects — { ok, message? }.
 */
async function handleInstantlyWebhook(
  payload: WebhookPayload,
): Promise<{ ok: boolean; message?: string }> {
  const body = payload.parsedBody as InstantlyPayload;
  const eventType = (body?.event_type ?? "").toString();
  const leadEmail = (body?.lead_email ?? "").toString().trim().toLowerCase() || null;
  const campaignId = (body?.campaign_id ?? "").toString() || null;
  const campaignName = (body?.campaign_name ?? "").toString() || null;
  const workspaceId = (body?.workspace ?? "").toString() || null;

  // 1. Token check (case-insensitive header name lookup — Next.js
  //    normalizes to lowercase, but be safe).
  const expectedToken = getSetting("instantly_webhook_token");
  const providedToken =
    payload.headers["x-webhook-token"] ?? payload.headers["X-Webhook-Token"] ?? "";
  const tokenValid = !!expectedToken && providedToken === expectedToken;

  // 2. Compute idempotency key + try to INSERT the audit row.
  const id = dedupHash(body);
  let isNewDelivery = true;
  try {
    sqlite
      .prepare(
        `INSERT INTO instantly_webhook_events
         (id, event_type, workspace_id, campaign_id, campaign_name, lead_email,
          payload, token_valid, handler_ok, handler_message, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, datetime('now'))`,
      )
      .run(
        id,
        eventType || "unknown",
        workspaceId,
        campaignId,
        campaignName,
        leadEmail,
        payload.body,
        tokenValid ? 1 : 0,
      );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE/i.test(msg)) {
      isNewDelivery = false;
    } else {
      // Real INSERT failure — fall through, but log so we know.
      console.error("[instantly-webhook] audit insert failed:", e);
    }
  }

  if (!tokenValid) {
    return { ok: false, message: "Invalid X-Webhook-Token" };
  }
  if (!isNewDelivery) {
    return { ok: true, message: "Duplicate delivery — idempotent skip" };
  }

  // 3. Resolve the lead → company.
  const match = resolveCompanyId({ leadEmail, instantlyCampaignId: campaignId });
  if (!match) {
    sqlite
      .prepare(`UPDATE instantly_webhook_events SET handler_ok = 1, handler_message = ? WHERE id = ?`)
      .run("no company match", id);
    return { ok: true, message: "No company match — logged only" };
  }

  // 4. Stamp campaign_leads if the event type maps to a status.
  if (match.campaignLeadId) {
    try {
      stampCampaignLead({
        campaignLeadId: match.campaignLeadId,
        eventType,
        payload: body,
      });
    } catch (e) {
      console.error("[instantly-webhook] campaign_leads update failed:", e);
    }
  }

  // 5. Write the activity_feed entry the prospect page renders.
  logToActivityFeed({ companyId: match.companyId, eventType, payload: body });

  // 6. Progress companies.status when the event implies a pipeline move.
  //    Forward-progress only — never downgrades a customer or wipes a
  //    later stage with an earlier one.
  const progression = companyStatusFor(eventType, match.companyId);
  let progressionMsg = "";
  if (progression) {
    const r = progressCompanyStatus(match.companyId, progression);
    if (r.updated) progressionMsg = ` status:${r.from}→${r.to}`;
  }

  // 7. Mark the audit row green.
  sqlite
    .prepare(`UPDATE instantly_webhook_events SET handler_ok = 1, handler_message = ? WHERE id = ?`)
    .run(`processed: company=${match.companyId}${progressionMsg}`, id);

  return { ok: true, message: `Processed ${eventType} for ${leadEmail}${progressionMsg}` };
}

/**
 * Map an Instantly event_type to the target companies.status (or null
 * for events that don't move the pipeline). Forward-progress is
 * enforced inside progressCompanyStatus — we only declare INTENT here.
 *
 * `campaign_completed` → ghosted only if NO reply_received has ever
 * landed for this company. Otherwise the campaign ending naturally
 * isn't a "ghost" — it's just the sequence finishing.
 */
function companyStatusFor(eventType: string, companyId: string): CompanyStatus | null {
  switch (eventType) {
    case "lead_interested":
      return "interested";
    case "lead_meeting_booked":
    case "lead_meeting_completed":
      // We don't book meetings (Jaxy's win is an order), but if PB
      // marks one, treat as a strong "interested" signal.
      return "interested";
    case "lead_not_interested":
      return "not_interested";
    case "lead_unsubscribed":
      // Effectively a hard no — treat as not_interested. The
      // unsubscribe flag itself lives on contacts.opted_out / similar.
      return "not_interested";
    case "campaign_completed": {
      // Ghosted ONLY if no reply ever landed for this company.
      const hasReply = sqlite
        .prepare(
          `SELECT 1 FROM instantly_webhook_events
            WHERE event_type = 'reply_received'
              AND id IN (
                SELECT id FROM instantly_webhook_events
                 WHERE lead_email IN (
                   SELECT email FROM campaign_leads WHERE company_id = ?
                 )
              )
            LIMIT 1`,
        )
        .get(companyId);
      return hasReply ? null : "ghosted";
    }
    default:
      return null;
  }
}

// Self-register at module load. The generic dispatcher route
// (src/app/api/webhooks/[provider]/route.ts) does a side-effect import
// of this module so the registration fires before the first request.
webhookRegistry.register("instantly", handleInstantlyWebhook);
