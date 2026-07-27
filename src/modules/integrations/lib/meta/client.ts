/**
 * Meta (Facebook/Instagram) Graph API + Conversions API client.
 *
 * Two directions:
 *   - INBOUND  (Lead Ads): the leadgen webhook delivers only a `leadgen_id`;
 *     fetchLead() exchanges it for the full submission (answers + ad
 *     attribution) using a long-lived Page/System-User token.
 *   - OUTBOUND (Conversions API): sendCapiEvents() posts CRM funnel events to
 *     the dataset so Meta can optimize ad delivery toward converting leads.
 *
 * All config comes from env (never DB) and every function degrades gracefully
 * when a token is missing — mirrors the Slack client's "never throw" contract
 * so an inbound webhook still returns 200 even if downstream calls fail.
 *
 * Env:
 *   META_APP_SECRET       — verifies X-Hub-Signature-256 on the webhook
 *   META_VERIFY_TOKEN     — echoed back on the GET subscription handshake
 *   META_PAGE_TOKEN       — System-User / Page token with leads_retrieval
 *   META_CAPI_TOKEN       — Conversions API token for the dataset
 *   META_DATASET_ID       — dataset (pixel) id           [default 2759076007773869]
 *   META_GRAPH_VERSION    — Graph API version            [default v25.0]
 *   META_TEST_EVENT_CODE  — optional; routes CAPI events to Test Events tab
 */

import { createHmac, timingSafeEqual, createHash } from "crypto";

const DEFAULT_DATASET_ID = "2759076007773869";
const DEFAULT_GRAPH_VERSION = "v25.0";

export function metaGraphVersion(): string {
  return process.env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION;
}
export function metaDatasetId(): string {
  return process.env.META_DATASET_ID || DEFAULT_DATASET_ID;
}
export function metaVerifyToken(): string | null {
  return process.env.META_VERIFY_TOKEN || null;
}
export function metaTestEventCode(): string | null {
  return process.env.META_TEST_EVENT_CODE || null;
}

export function metaConfig() {
  return {
    appSecret: process.env.META_APP_SECRET || null,
    verifyToken: process.env.META_VERIFY_TOKEN || null,
    pageToken: process.env.META_PAGE_TOKEN || null,
    capiToken: process.env.META_CAPI_TOKEN || null,
    datasetId: metaDatasetId(),
    graphVersion: metaGraphVersion(),
    testEventCode: metaTestEventCode(),
  };
}

/** True when the inbound Lead Ads path is fully configured. */
export function metaLeadsConfigured(): boolean {
  const c = metaConfig();
  return !!(c.appSecret && c.pageToken);
}

/** True when the outbound Conversions API path is fully configured. */
export function metaCapiConfigured(): boolean {
  const c = metaConfig();
  return !!(c.capiToken && c.datasetId);
}

const GRAPH_BASE = "https://graph.facebook.com";

// ── Signature verification ──

/**
 * Verify Meta's `X-Hub-Signature-256: sha256=<hex>` header against the raw
 * request body using the app secret. Constant-time. Returns false on any
 * malformed input rather than throwing.
 */
export function verifyMetaSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret || !signatureHeader) return false;
  const expected = signatureHeader.startsWith("sha256=") ? signatureHeader.slice(7) : signatureHeader;
  const hash = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  try {
    return timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── PII hashing (Conversions API matching) ──

/**
 * Normalize + SHA256-hash a value for Meta's user_data matching. Meta requires
 * lowercase, trimmed, no spaces for email; digits-only for phone. Returns null
 * for empty input.
 */
export function hashEmail(email: string | null | undefined): string | null {
  const v = (email ?? "").trim().toLowerCase();
  if (!v || !v.includes("@")) return null;
  return createHash("sha256").update(v).digest("hex");
}

export function hashPhone(phone: string | null | undefined): string | null {
  // Meta wants E.164-ish: country code + number, digits only, no leading +.
  const digits = (phone ?? "").replace(/[^\d]/g, "");
  if (!digits) return null;
  // Default US country code when a 10-digit number arrives without one.
  const normalized = digits.length === 10 ? `1${digits}` : digits;
  return createHash("sha256").update(normalized).digest("hex");
}

// ── Inbound: Lead Ads ──

export interface MetaLeadField {
  name: string;
  values: string[];
}
export interface MetaLeadDetail {
  id: string;
  created_time?: string;
  field_data: MetaLeadField[];
  form_id?: string;
  campaign_name?: string;
  adset_name?: string;
  ad_name?: string;
  ad_id?: string;
}

/**
 * Fetch the full lead for a leadgen_id. Returns null if unconfigured or the
 * lead can't be read (logs the reason). Never throws.
 */
export async function fetchLead(leadgenId: string): Promise<MetaLeadDetail | null> {
  const c = metaConfig();
  const token = await pageScopedToken();
  if (!token) {
    console.warn("[meta] fetchLead skipped — META_PAGE_TOKEN not set");
    return null;
  }
  const fields = "id,created_time,field_data,form_id,campaign_name,adset_name,ad_name,ad_id";
  const url = `${GRAPH_BASE}/${c.graphVersion}/${leadgenId}?fields=${fields}&access_token=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(url);
    const data = (await res.json()) as MetaLeadDetail & { error?: { message?: string } };
    if (!res.ok || data.error) {
      console.warn(`[meta] fetchLead ${leadgenId} failed:`, data.error?.message || `HTTP ${res.status}`);
      return null;
    }
    return data;
  } catch (e) {
    console.warn(`[meta] fetchLead ${leadgenId} threw:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Page a form's leads (newest first). Used by the reconciliation cron to catch
 * anything the webhook dropped. Returns [] on any failure.
 */
export async function fetchFormLeads(formId: string, limit = 50): Promise<MetaLeadDetail[]> {
  const c = metaConfig();
  const token = await pageScopedToken();
  if (!token) return [];
  const fields = "id,created_time,field_data,campaign_name,adset_name,ad_name,ad_id";
  let url: string | null =
    `${GRAPH_BASE}/${c.graphVersion}/${formId}/leads?fields=${fields}&limit=${limit}&access_token=${encodeURIComponent(token)}`;
  const out: MetaLeadDetail[] = [];
  try {
    // One page is enough for a safety-net sweep; guard against runaway paging.
    for (let page = 0; page < 3 && url; page++) {
      const res: Response = await fetch(url);
      const data = (await res.json()) as { data?: MetaLeadDetail[]; paging?: { next?: string }; error?: { message?: string } };
      if (!res.ok || data.error) {
        console.warn(`[meta] fetchFormLeads ${formId} failed:`, data.error?.message || `HTTP ${res.status}`);
        break;
      }
      for (const d of data.data ?? []) out.push({ ...d, form_id: formId });
      url = data.paging?.next ?? null;
    }
  } catch (e) {
    console.warn(`[meta] fetchFormLeads ${formId} threw:`, e instanceof Error ? e.message : e);
  }
  return out;
}

// ── Diagnostics / discovery ──

export interface MetaPage {
  id: string;
  name?: string;
  /** Apps subscribed to this page, with the fields they listen to. */
  subscribedApps?: Array<{ id?: string; name?: string; subscribed_fields?: string[] }>;
  leadgenSubscribed?: boolean;
  forms?: Array<{ id: string; name?: string; status?: string; leads_count?: number }>;
  error?: string;
}

/**
 * Page-scoped tokens, derived once per process.
 *
 * Lead Ads endpoints (`/{page}/leadgen_forms`, `/{form}/leads`, the lead
 * itself) reject anything that isn't a PAGE access token with
 * "(#190) This method must be called with a Page Access Token". People
 * naturally paste a User or System-User token instead, so rather than demand
 * the exact right one we exchange whatever we're given: `/me/accounts` returns
 * each assigned Page together with its own token. If the configured value is
 * already a Page token, `/me/accounts` returns nothing useful and we fall
 * back to using it directly.
 */
let pageTokenCache: { at: number; pages: Array<{ id: string; name?: string; token: string }> } | null = null;
const PAGE_TOKEN_TTL_MS = 10 * 60_000;

export async function resolvePageTokens(force = false): Promise<Array<{ id: string; name?: string; token: string }>> {
  const c = metaConfig();
  if (!c.pageToken) return [];
  if (!force && pageTokenCache && Date.now() - pageTokenCache.at < PAGE_TOKEN_TTL_MS) {
    return pageTokenCache.pages;
  }

  const pages: Array<{ id: string; name?: string; token: string }> = [];
  try {
    const res = await fetch(
      `${GRAPH_BASE}/${c.graphVersion}/me/accounts?fields=id,name,access_token&limit=50&access_token=${encodeURIComponent(c.pageToken)}`,
    );
    const data = (await res.json()) as { data?: Array<{ id: string; name?: string; access_token?: string }> };
    for (const p of data.data ?? []) {
      if (p.access_token) pages.push({ id: p.id, name: p.name, token: p.access_token });
    }
  } catch {
    /* fall through to the configured token */
  }

  // Already a Page token (or /me/accounts unavailable): use it as-is. Identify
  // the page so page-scoped calls still have an id to work with.
  if (pages.length === 0) {
    try {
      const res = await fetch(`${GRAPH_BASE}/${c.graphVersion}/me?fields=id,name&access_token=${encodeURIComponent(c.pageToken)}`);
      const me = (await res.json()) as { id?: string; name?: string };
      if (me.id) pages.push({ id: me.id, name: me.name, token: c.pageToken });
    } catch {
      /* nothing more we can do */
    }
  }

  pageTokenCache = { at: Date.now(), pages };
  return pages;
}

/** The best token for page-scoped reads: a derived Page token, else the raw one. */
async function pageScopedToken(): Promise<string | null> {
  const pages = await resolvePageTokens();
  return pages[0]?.token ?? metaConfig().pageToken;
}

async function graph<T>(path: string, token: string): Promise<T | { error: string }> {
  try {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${GRAPH_BASE}/${metaGraphVersion()}${path}${sep}access_token=${encodeURIComponent(token)}`);
    const data = (await res.json()) as T & { error?: { message?: string } };
    if (!res.ok || data.error) return { error: data.error?.message || `HTTP ${res.status}` };
    return data;
  } catch (e) {
    return { error: e instanceof Error ? e.message : "request failed" };
  }
}

/**
 * Inspect what the Page token can actually see: which token it is, which Pages
 * it can access, whether our app is subscribed to each Page's `leadgen` field,
 * and which lead forms exist. This answers "everything says connected but no
 * leads are arriving" without guesswork.
 */
export async function diagnoseLeadAccess(): Promise<{
  token: { valid: boolean; type?: string; appId?: string; scopes?: string[]; error?: string };
  pages: MetaPage[];
  error?: string;
}> {
  const c = metaConfig();
  if (!c.pageToken) return { token: { valid: false, error: "META_PAGE_TOKEN not set" }, pages: [] };

  // What kind of token is this, and does it carry leads_retrieval?
  const dbg = await graph<{ data?: { is_valid?: boolean; type?: string; app_id?: string; scopes?: string[] } }>(
    `/debug_token?input_token=${encodeURIComponent(c.pageToken)}`,
    c.pageToken,
  );
  const token = "error" in dbg
    ? { valid: false, error: dbg.error }
    : {
        valid: Boolean(dbg.data?.is_valid),
        type: dbg.data?.type,
        appId: dbg.data?.app_id,
        scopes: dbg.data?.scopes,
      };

  // Exchange for page-scoped tokens — page-level reads reject user tokens
  // with "(#190) This method must be called with a Page Access Token".
  const resolved = await resolvePageTokens(true);

  const pages: MetaPage[] = [];
  for (const p of resolved.slice(0, 10)) {
    const page: MetaPage = { id: p.id, name: p.name };

    const subs = await graph<{ data?: Array<{ id?: string; name?: string; subscribed_fields?: string[] }> }>(
      `/${p.id}/subscribed_apps`, p.token,
    );
    if ("error" in subs) page.error = subs.error;
    else {
      page.subscribedApps = subs.data ?? [];
      page.leadgenSubscribed = (subs.data ?? []).some((a) => (a.subscribed_fields ?? []).includes("leadgen"));
    }

    const forms = await graph<{ data?: Array<{ id: string; name?: string; status?: string; leads_count?: number }> }>(
      `/${p.id}/leadgen_forms?fields=id,name,status,leads_count&limit=50`, p.token,
    );
    if ("error" in forms) page.error = page.error ?? forms.error;
    else page.forms = forms.data ?? [];

    pages.push(page);
  }

  return {
    token,
    pages,
    error: resolved.length === 0
      ? "This token can't reach any Page. Assign the Jaxy Page to the System User (Manage Page access) and regenerate, or paste a Page access token."
      : undefined,
  };
}

/**
 * Subscribe our app to a Page's `leadgen` field. This is the step people miss:
 * configuring the webhook in the App dashboard is not the same as subscribing
 * the Page to the app.
 */
export async function subscribePageToLeadgen(pageId: string): Promise<{ ok: boolean; error?: string }> {
  const c = metaConfig();
  if (!c.pageToken) return { ok: false, error: "META_PAGE_TOKEN not set" };
  // Subscribing a Page also requires that Page's own token.
  const pages = await resolvePageTokens();
  const token = pages.find((p) => p.id === pageId)?.token ?? c.pageToken;
  try {
    const res = await fetch(
      `${GRAPH_BASE}/${c.graphVersion}/${pageId}/subscribed_apps?subscribed_fields=leadgen&access_token=${encodeURIComponent(token)}`,
      { method: "POST" },
    );
    const data = (await res.json()) as { success?: boolean; error?: { message?: string } };
    if (!res.ok || data.error) return { ok: false, error: data.error?.message || `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "request failed" };
  }
}

// ── Outbound: Conversions API ──

export interface CapiEvent {
  event_name: string;
  event_time: number;
  action_source: "system_generated";
  custom_data: { event_source: "crm"; lead_event_source: string };
  user_data: {
    lead_id?: number;
    em?: string[];
    ph?: string[];
  };
}

export interface CapiSendResult {
  ok: boolean;
  eventsReceived?: number;
  fbtraceId?: string;
  error?: string;
}

/**
 * Post CRM events to the dataset's /events endpoint. When META_TEST_EVENT_CODE
 * is set (or testCode passed), events route to the Test Events tab instead of
 * production. Never throws.
 */
export async function sendCapiEvents(events: CapiEvent[], testCode?: string | null): Promise<CapiSendResult> {
  const c = metaConfig();
  if (!c.capiToken) return { ok: false, error: "META_CAPI_TOKEN not set" };
  if (events.length === 0) return { ok: true, eventsReceived: 0 };

  const body: Record<string, unknown> = { data: events };
  const code = testCode ?? c.testEventCode;
  if (code) body.test_event_code = code;

  const url = `${GRAPH_BASE}/${c.graphVersion}/${c.datasetId}/events?access_token=${encodeURIComponent(c.capiToken)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as {
      events_received?: number;
      fbtrace_id?: string;
      error?: { message?: string; error_user_msg?: string };
    };
    if (!res.ok || data.error) {
      return { ok: false, error: data.error?.error_user_msg || data.error?.message || `HTTP ${res.status}`, fbtraceId: data.fbtrace_id };
    }
    return { ok: true, eventsReceived: data.events_received, fbtraceId: data.fbtrace_id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
