/**
 * Pipedrive inbound webhooks — the pull half of the two-way sync.
 *
 * Pipedrive POSTs deal/person/organization changes here via the generic
 * dispatcher (/api/webhooks/pipedrive). The dispatcher does no auth, so this
 * handler verifies HTTP Basic auth itself against credentials stored in
 * settings (pipedrive_webhook_user / pipedrive_webhook_password) — the same
 * creds set on the webhook in Pipedrive.
 *
 * Conflict resolution (docs §5): deal stage → Pipedrive authoritative (we
 * mirror it into the projection); account status / identity / revenue → frame
 * authoritative. A deal moving to Won is advisory only — it does NOT set
 * `customer` (keystone #3: customer is reached solely via a real order). A
 * deal moving to Lost maps by lost_reason → a terminal frame status. Every
 * frame-status change made here carries source:"pipedrive" so the fan-out
 * never echoes back to Pipedrive.
 */

import crypto from "crypto";
import { sqlite } from "@/lib/db";
import { webhookRegistry, type WebhookPayload } from "@/modules/core/lib/webhooks";
import { pdRequest } from "./pipedrive-client";
import { getPipelineConfig } from "./pipedrive-setup";
import { progressCompanyStatus, type CompanyStatus } from "./status-progression";

function getSetting(key: string): string | null {
  const r = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string | null }
    | undefined;
  return r?.value ?? null;
}

function setSetting(key: string, value: string): void {
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, type, module, updated_at)
       VALUES (?, ?, 'string', 'sales', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(key, value);
}

/**
 * Register (or re-register) the inbound Pipedrive webhook pointed at
 * /api/webhooks/pipedrive, storing the Basic-auth creds the handler verifies.
 * Returns the creds once. Shared by the admin route and the settings UI.
 */
export async function registerInboundWebhook(
  opts: { user?: string; password?: string } = {},
): Promise<{ webhook: unknown; subscriptionUrl: string; credentials: { user: string; password: string } }> {
  const user = opts.user || "pipedrive";
  const password = opts.password || crypto.randomBytes(18).toString("base64url");
  setSetting("pipedrive_webhook_user", user);
  setSetting("pipedrive_webhook_password", password);
  const base = (
    process.env.PIPEDRIVE_APP_URL ||
    process.env.SHOPIFY_APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
  const subscriptionUrl = `${base}/api/webhooks/pipedrive`;
  const webhook = await pdRequest("POST", "/webhooks", {
    subscription_url: subscriptionUrl,
    event_action: "*",
    event_object: "*",
    http_auth_user: user,
    http_auth_password: password,
    version: "1.0",
  });
  return { webhook, subscriptionUrl, credentials: { user, password } };
}

/** Whether inbound webhook Basic-auth creds have been stored. */
export function isInboundWebhookConfigured(): boolean {
  return !!getSetting("pipedrive_webhook_user") && !!getSetting("pipedrive_webhook_password");
}

// ── auth ─────────────────────────────────────────────────────────────────────

function basicAuthValid(headers: Record<string, string>): boolean {
  const user = getSetting("pipedrive_webhook_user");
  const pass = getSetting("pipedrive_webhook_password");
  if (!user || !pass) return false; // not configured → reject (fail closed)
  const auth = headers["authorization"] || headers["Authorization"] || "";
  if (!auth.toLowerCase().startsWith("basic ")) return false;
  let decoded = "";
  try {
    decoded = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;
  const gotUser = decoded.slice(0, sep);
  const gotPass = decoded.slice(sep + 1);
  // constant-time-ish compare
  return safeEqual(gotUser, user) && safeEqual(gotPass, pass);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ── payload shape ─────────────────────────────────────────────────────────────

interface PdWebhookBody {
  // v1: { event: "updated.deal", meta: {action, object, id}, current, previous }
  // v2: { meta: {action, entity, ...}, data, previous }
  event?: string;
  meta?: { action?: string; object?: string; entity?: string; id?: number | string };
  current?: Record<string, unknown>;
  data?: Record<string, unknown>;
  previous?: Record<string, unknown>;
}

function parseMeta(body: PdWebhookBody): { action: string; object: string; id: number | null } {
  let action = body.meta?.action || "";
  let object = body.meta?.object || body.meta?.entity || "";
  if ((!action || !object) && body.event && body.event.includes(".")) {
    const [a, o] = body.event.split(".");
    action = action || a;
    object = object || o;
  }
  const rawId = body.meta?.id ?? (body.current?.id as number) ?? (body.data?.id as number) ?? null;
  const id = rawId == null ? null : Number(rawId);
  return { action: action.toLowerCase(), object: object.toLowerCase(), id };
}

function dealFields(body: PdWebhookBody): Record<string, unknown> {
  return (body.current || body.data || {}) as Record<string, unknown>;
}

// ── lost-reason mapping (docs §5) ─────────────────────────────────────────────

function mapLostReason(reason: string | null | undefined): CompanyStatus {
  const r = (reason || "").toLowerCase();
  if (/revisit|later|timing|budget|not now/.test(r)) return "revisit_later";
  if (/ghost|no response|unresponsive|no reply|never replied/.test(r)) return "ghosted";
  return "not_interested";
}

// ── projection helpers ────────────────────────────────────────────────────────

interface ProjRow {
  id: string;
  pipedrive_deal_id: number | null;
  company_id: string | null;
  pipeline: string | null;
  stage: string | null;
}

function getProjection(dealId: number): ProjRow | undefined {
  return sqlite
    .prepare("SELECT id, pipedrive_deal_id, company_id, pipeline, stage FROM pipedrive_deals WHERE pipedrive_deal_id = ?")
    .get(dealId) as ProjRow | undefined;
}

/** Reverse-map a Pipedrive stage_id → {pipelineKey, stageName} via the config. */
function resolveStage(stageId: number | null): { pipeline: string; stage: string } | null {
  if (!stageId) return null;
  const config = getPipelineConfig();
  if (!config) return null;
  for (const key of ["ajm", "catalog", "customers"] as const) {
    for (const [name, id] of Object.entries(config[key].stages)) {
      if (id === stageId) return { pipeline: key, stage: name };
    }
  }
  return null;
}

/** Find the frame company behind a manually-created Pipedrive deal (docs §8.4). */
async function resolveCompanyFromDeal(orgId: number | null): Promise<string | null> {
  if (!orgId) return null;
  // stamped link first
  const byStamp = sqlite
    .prepare("SELECT id FROM companies WHERE pipedrive_org_id = ? LIMIT 1")
    .get(orgId) as { id: string } | undefined;
  if (byStamp) return byStamp.id;
  // then the org's frame_company_id custom field
  try {
    const keysRaw = getSetting("pipedrive_custom_fields");
    if (!keysRaw) return null;
    const keys = JSON.parse(keysRaw) as { orgFrameCompanyId?: string };
    if (!keys.orgFrameCompanyId) return null;
    const detail = await pdRequest<Record<string, unknown>>("GET", `/organizations/${orgId}`);
    const frameId = String(detail?.[keys.orgFrameCompanyId] ?? "");
    if (frameId) {
      const exists = sqlite.prepare("SELECT id FROM companies WHERE id = ?").get(frameId) as { id: string } | undefined;
      return exists?.id ?? null;
    }
  } catch {
    /* best-effort */
  }
  return null;
}

// ── deal handler ──────────────────────────────────────────────────────────────

/**
 * Activity done/deleted in Pipedrive → drop the contact from the rep's
 * PhoneBurner call folder (the reverse of the daily builder). This keeps
 * the call list in sync when a rep completes an activity in Pipedrive
 * rather than by dialing in PhoneBurner.
 */
async function handleActivity(body: PdWebhookBody, action: string, activityId: number): Promise<string> {
  const cur = (body.current || body.data || {}) as Record<string, unknown>;
  const done = cur.done === true || cur.done === 1 || String(cur.done) === "true";
  if (action === "deleted" || done) {
    const { removeFromCallListByActivity } = await import("./pipedrive-call-sync");
    const removed = await removeFromCallListByActivity(activityId);
    return removed
      ? `activity ${activityId} ${action}${done ? " (done)" : ""} → removed from call list`
      : `activity ${activityId} — not on a call list`;
  }
  return `activity ${action} — no action`;
}

async function handleDeal(body: PdWebhookBody, dealId: number): Promise<string> {
  const f = dealFields(body);
  const status = String(f.status ?? "");
  const stageId = f.stage_id != null ? Number(f.stage_id) : null;
  const lostReason = (f.lost_reason as string) ?? null;
  const orgId = f.org_id != null ? Number(f.org_id) : null;

  let proj = getProjection(dealId);
  let companyId = proj?.company_id ?? null;

  // Manual Pipedrive deal we've never seen → try to link it to a frame company.
  if (!proj) {
    companyId = await resolveCompanyFromDeal(orgId);
    const sm = resolveStage(stageId);
    sqlite
      .prepare(
        `INSERT INTO pipedrive_deals (id, pipedrive_deal_id, company_id, pipeline, stage, status, is_open, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(pipedrive_deal_id) DO NOTHING`,
      )
      .run(
        crypto.randomUUID(),
        dealId,
        companyId,
        sm?.pipeline ?? null,
        sm?.stage ?? null,
        status || "open",
        status === "open" || !status ? 1 : 0,
      );
    proj = getProjection(dealId);
  }

  // Stage is Pipedrive-authoritative → mirror into the projection.
  if (status === "open" && stageId) {
    const sm = resolveStage(stageId);
    if (sm) {
      sqlite
        .prepare("UPDATE pipedrive_deals SET stage = ?, pipeline = COALESCE(pipeline, ?), is_open = 1, status = 'open', updated_at = datetime('now') WHERE pipedrive_deal_id = ?")
        .run(sm.stage, sm.pipeline, dealId);
    }
    return `deal ${dealId} stage → ${sm?.stage ?? stageId}`;
  }

  if (status === "won") {
    // Advisory only — does NOT set customer (keystone #3).
    sqlite
      .prepare("UPDATE pipedrive_deals SET status='won', is_open=0, updated_at=datetime('now') WHERE pipedrive_deal_id = ?")
      .run(dealId);
    return `deal ${dealId} won (advisory; customer set only by a real order)`;
  }

  if (status === "lost") {
    sqlite
      .prepare("UPDATE pipedrive_deals SET status='lost', is_open=0, updated_at=datetime('now') WHERE pipedrive_deal_id = ?")
      .run(dealId);
    if (companyId) {
      const mapped = mapLostReason(lostReason);
      const res = progressCompanyStatus(companyId, mapped, { source: "pipedrive" });
      return `deal ${dealId} lost → ${mapped}${res.updated ? "" : " (no-op)"}`;
    }
    return `deal ${dealId} lost (no linked company)`;
  }

  return `deal ${dealId} ${status || "changed"} — no action`;
}

// ── person handler (light) ─────────────────────────────────────────────────────

function handlePerson(action: string, personId: number): string {
  if (action === "deleted") {
    const c = sqlite.prepare("SELECT id FROM companies WHERE pipedrive_person_id = ?").get(personId) as
      | { id: string }
      | undefined;
    if (c) {
      sqlite.prepare("UPDATE companies SET pipedrive_person_id = NULL WHERE id = ?").run(c.id);
      return `person ${personId} deleted → unlinked from company ${c.id}`;
    }
  }
  return `person ${personId} ${action} — logged`;
}

// ── main handler ───────────────────────────────────────────────────────────────

async function handlePipedriveWebhook(payload: WebhookPayload): Promise<{ ok: boolean; message?: string }> {
  const body = (payload.parsedBody ?? {}) as PdWebhookBody;
  const { action, object, id } = parseMeta(body);

  const authValid = basicAuthValid(payload.headers);

  // Audit + idempotency. dedup_key = hash of the raw delivery (retries are
  // byte-identical; distinct updates differ).
  const dedupKey = crypto.createHash("sha256").update(payload.body || "").digest("hex");
  let isNew = true;
  try {
    sqlite
      .prepare(
        `INSERT INTO pipedrive_webhook_events
           (id, dedup_key, event, object, action, pipedrive_id, payload, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        crypto.randomUUID(),
        dedupKey,
        body.event ?? `${action}.${object}`,
        object,
        action,
        id,
        payload.body,
        authValid ? "received" : "unauthorized",
      );
  } catch (e) {
    if (/UNIQUE/i.test(e instanceof Error ? e.message : String(e))) isNew = false;
    else console.error("[pipedrive-webhook] audit insert failed:", e);
  }

  if (!authValid) return { ok: false, message: "Invalid webhook credentials" };
  if (!isNew) return { ok: true, message: "Duplicate delivery — idempotent skip" };
  if (!object || id == null) return { ok: true, message: "No actionable object" };

  try {
    let message = "";
    if (object === "deal") message = await handleDeal(body, id);
    else if (object === "person") message = handlePerson(action, id);
    else if (object === "activity") message = await handleActivity(body, action, id);
    else message = `${object} ${action} — no handler`;

    sqlite
      .prepare("UPDATE pipedrive_webhook_events SET status='processed', error=NULL WHERE dedup_key = ?")
      .run(dedupKey);
    return { ok: true, message };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    sqlite.prepare("UPDATE pipedrive_webhook_events SET status='error', error=? WHERE dedup_key = ?").run(err, dedupKey);
    console.error("[pipedrive-webhook] handler error:", e);
    return { ok: false, message: err };
  }
}

webhookRegistry.register("pipedrive", handlePipedriveWebhook);
