/**
 * Pipedrive integration — OAuth2 client + typed API helpers.
 *
 * Mirrors the Xero client pattern (src/modules/finance/lib/xero-client.ts):
 * env-based app credentials, DB-stored tokens in the `settings` k/v table,
 * and transparent refresh. Pipedrive returns an `api_domain` on token
 * exchange (e.g. https://jaxy.pipedrive.com) which is the base for all API
 * calls, so we persist and reuse it.
 *
 * Auth model: a private OAuth app in the Pipedrive Developer Hub. The user
 * connects once via /api/auth/pipedrive; tokens are stored and auto-refreshed.
 *
 * Docs: https://developers.pipedrive.com/docs/api/v1/Oauth
 */

import { db } from "@/lib/db";
import { settings } from "@/modules/core/schema";
import { eq } from "drizzle-orm";

const AUTH_URL = "https://oauth.pipedrive.com/oauth/authorize";
const TOKEN_URL = "https://oauth.pipedrive.com/oauth/token";

interface PipedriveConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function getConfig(): PipedriveConfig | null {
  // Canonical names are PIPEDRIVE_CLIENT_ID / PIPEDRIVE_CLIENT_SECRET, but
  // accept common variants so a lowercase/short env name still works.
  const clientId =
    process.env.PIPEDRIVE_CLIENT_ID || process.env.pipedrive_client_id;
  const clientSecret =
    process.env.PIPEDRIVE_CLIENT_SECRET ||
    process.env.PIPEDRIVE_SECRET ||
    process.env.pipedrive_client_secret ||
    process.env.pipedrive_secret;
  const appUrl =
    process.env.PIPEDRIVE_APP_URL ||
    process.env.SHOPIFY_APP_URL ||
    "http://localhost:3000";
  const redirectUri =
    process.env.PIPEDRIVE_REDIRECT_URI ||
    `${appUrl.replace(/\/$/, "")}/api/auth/pipedrive/callback`;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri };
}

export function isPipedriveConfigured(): boolean {
  return getConfig() !== null;
}

export function getPipedriveRedirectUri(): string | null {
  return getConfig()?.redirectUri ?? null;
}

// ── settings helpers ──────────────────────────────────────────────────────

function getSetting(key: string): string | null {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
}

function setSetting(key: string, value: string): void {
  db.insert(settings)
    .values({ key, value, type: "string" as const, module: "sales" })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date().toISOString() } })
    .run();
}

// ── OAuth ──────────────────────────────────────────────────────────────────

/** Build the consent URL. Caller injects its own CSRF `state`. */
export function getPipedriveAuthUrl(state: string): string | null {
  const config = getConfig();
  if (!config) return null;
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state,
  });
  // Scopes are defined on the app in the Developer Hub; only send if pinned.
  if (process.env.PIPEDRIVE_SCOPES) params.set("scope", process.env.PIPEDRIVE_SCOPES);
  return `${AUTH_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  api_domain: string;
}

/** Exchange an authorization code for tokens and persist them. */
export async function exchangePipedriveCode(
  code: string,
): Promise<{ success: boolean; apiDomain?: string; error?: string }> {
  const config = getConfig();
  if (!config) return { success: false, error: "Pipedrive not configured (set PIPEDRIVE_CLIENT_ID/SECRET)" };

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
    }),
  });
  if (!res.ok) {
    return { success: false, error: `Token exchange failed: ${(await res.text()).slice(0, 300)}` };
  }
  const data = (await res.json()) as TokenResponse;
  persistTokens(data);

  // Capture company/user label for the connection card (best-effort).
  try {
    const me = await fetch(`${data.api_domain}/v1/users/me`, {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (me.ok) {
      const j = await me.json();
      const name = j?.data?.company_name || j?.data?.name || "";
      if (name) setSetting("pipedrive_company_name", String(name));
    }
  } catch {
    /* non-fatal */
  }

  return { success: true, apiDomain: data.api_domain };
}

function persistTokens(data: TokenResponse): void {
  setSetting("pipedrive_access_token", data.access_token);
  setSetting("pipedrive_refresh_token", data.refresh_token);
  setSetting("pipedrive_token_expires_at", String(Date.now() + data.expires_in * 1000));
  setSetting("pipedrive_api_domain", data.api_domain.replace(/\/$/, ""));
  setSetting("pipedrive_connected_at", new Date().toISOString());
}

/** Load tokens, refreshing if within 2 min of expiry. Returns null if not connected. */
async function getAuth(): Promise<{ token: string; apiDomain: string } | null> {
  const access = getSetting("pipedrive_access_token");
  const refresh = getSetting("pipedrive_refresh_token");
  const apiDomain = getSetting("pipedrive_api_domain");
  if (!access || !refresh || !apiDomain) return null;

  const expiresAt = parseInt(getSetting("pipedrive_token_expires_at") || "0", 10);
  if (Date.now() < expiresAt - 120_000) return { token: access, apiDomain };

  // Refresh
  const config = getConfig();
  if (!config) return null;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
  });
  if (!res.ok) {
    console.error("[pipedrive] token refresh failed:", res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const data = (await res.json()) as TokenResponse;
  // Pipedrive may not re-send api_domain on refresh; keep the existing one.
  if (!data.api_domain) data.api_domain = apiDomain;
  persistTokens(data);
  return { token: data.access_token, apiDomain: data.api_domain.replace(/\/$/, "") };
}

export function getPipedriveConnectionStatus(): {
  connected: boolean;
  companyName?: string;
  apiDomain?: string;
  connectedAt?: string;
} {
  return {
    connected: !!getSetting("pipedrive_access_token"),
    companyName: getSetting("pipedrive_company_name") || undefined,
    apiDomain: getSetting("pipedrive_api_domain") || undefined,
    connectedAt: getSetting("pipedrive_connected_at") || undefined,
  };
}

export function disconnectPipedrive(): void {
  for (const k of [
    "pipedrive_access_token", "pipedrive_refresh_token", "pipedrive_token_expires_at",
    "pipedrive_api_domain", "pipedrive_connected_at", "pipedrive_company_name",
  ]) {
    db.delete(settings).where(eq(settings.key, k)).run();
  }
}

// ── Core request helper ─────────────────────────────────────────────────────

export class PipedriveError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PipedriveError";
    this.status = status;
  }
}

/**
 * Authenticated request against the Pipedrive API (v1 by default).
 * Retries once on 401 (forces a token refresh) and respects 429 Retry-After.
 * Returns the parsed `data` field (Pipedrive wraps responses in {success,data}).
 */
export async function pdRequest<T = unknown>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  opts: { version?: "v1" | "v2"; retriesLeft?: number } = {},
): Promise<T> {
  const auth = await getAuth();
  if (!auth) throw new PipedriveError("Pipedrive not connected", 401);

  const version = opts.version ?? "v1";
  const url = path.startsWith("http") ? path : `${auth.apiDomain}/${version}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 429) {
    const retry = parseInt(res.headers.get("retry-after") || "2", 10);
    const left = opts.retriesLeft ?? 3;
    if (left > 0) {
      await new Promise((r) => setTimeout(r, Math.min(retry, 10) * 1000));
      return pdRequest<T>(method, path, body, { ...opts, retriesLeft: left - 1 });
    }
  }
  if (res.status === 401 && (opts.retriesLeft ?? 1) > 0) {
    // Force-expire and retry once.
    setSetting("pipedrive_token_expires_at", "0");
    return pdRequest<T>(method, path, body, { ...opts, retriesLeft: 0 });
  }
  if (!res.ok) {
    throw new PipedriveError(`Pipedrive ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 400)}`, res.status);
  }
  const json = await res.json();
  return (json?.data ?? json) as T;
}

/** Lightweight auth probe for the settings/integration card. */
export async function pingPipedrive(): Promise<{ ok: boolean; companyName?: string; error?: string }> {
  try {
    const me = await pdRequest<{ company_name?: string; name?: string }>("GET", "/users/me");
    return { ok: true, companyName: me?.company_name || me?.name };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Resource helpers (used by pipedrive-sync) ───────────────────────────────

export interface PdPipeline { id: number; name: string }
export interface PdStage { id: number; name: string; pipeline_id: number; order_nr: number }

export async function listPipelines(): Promise<PdPipeline[]> {
  return (await pdRequest<PdPipeline[]>("GET", "/pipelines")) || [];
}
export async function listStages(): Promise<PdStage[]> {
  return (await pdRequest<PdStage[]>("GET", "/stages")) || [];
}

export interface PdUser { id: number; name: string; email: string; active_flag: boolean }
export async function listUsers(): Promise<PdUser[]> {
  return (await pdRequest<PdUser[]>("GET", "/users")) || [];
}

// ── Read helpers (for the per-company Pipedrive panel) ───────────────────────

export interface PdOrg { id: number; name: string; address?: string; owner_id?: unknown; [k: string]: unknown }
export interface PdDeal {
  id: number;
  title: string;
  status: string;
  value?: number;
  currency?: string;
  pipeline_id?: number;
  stage_id?: number;
  user_id?: { id?: number; name?: string } | number;
  add_time?: string;
  update_time?: string;
  won_time?: string;
  [k: string]: unknown;
}
export interface PdActivity {
  id: number;
  subject?: string;
  type?: string;
  done?: boolean;
  due_date?: string;
  marked_as_done_time?: string;
  add_time?: string;
  note?: string;
  [k: string]: unknown;
}
export interface PdPerson { id: number; name?: string; email?: unknown; phone?: unknown; [k: string]: unknown }

export async function getOrganization(orgId: number): Promise<PdOrg | null> {
  try {
    return await pdRequest<PdOrg>("GET", `/organizations/${orgId}`);
  } catch {
    return null;
  }
}

export async function getPerson(personId: number): Promise<PdPerson | null> {
  try {
    return await pdRequest<PdPerson>("GET", `/persons/${personId}`);
  } catch {
    return null;
  }
}

export async function listDealsForOrg(orgId: number): Promise<PdDeal[]> {
  // NOTE: GET /deals does NOT support an org_id filter — it silently ignores it
  // and returns every deal. Deals for one org come from the org sub-resource.
  return (await pdRequest<PdDeal[]>("GET", `/organizations/${orgId}/deals?limit=50&status=all_not_deleted`)) || [];
}

export async function listActivitiesForOrg(orgId: number, limit = 15): Promise<PdActivity[]> {
  // Same caveat as deals: filter via the org sub-resource, not /activities?org_id=.
  return (await pdRequest<PdActivity[]>("GET", `/organizations/${orgId}/activities?limit=${limit}&done=1`)) || [];
}

export interface PdCreated { id: number }

export async function createOrganization(input: {
  name: string;
  owner_id?: number;
  address?: string;
  [k: string]: unknown;
}): Promise<PdCreated> {
  return pdRequest<PdCreated>("POST", "/organizations", input);
}

export async function updateOrganization(id: number, input: Record<string, unknown>): Promise<PdCreated> {
  return pdRequest<PdCreated>("PUT", `/organizations/${id}`, input);
}

export async function createPerson(input: {
  name: string;
  org_id?: number;
  owner_id?: number;
  email?: string[];
  phone?: string[];
  [k: string]: unknown;
}): Promise<PdCreated> {
  return pdRequest<PdCreated>("POST", "/persons", input);
}

export async function updatePerson(id: number, input: Record<string, unknown>): Promise<PdCreated> {
  return pdRequest<PdCreated>("PUT", `/persons/${id}`, input);
}

export async function createDeal(input: {
  title: string;
  org_id?: number;
  person_id?: number;
  pipeline_id?: number;
  stage_id?: number;
  user_id?: number; // deals use user_id for the owner (orgs/persons use owner_id)
  value?: number;
  currency?: string;
  status?: "open" | "won" | "lost";
  won_time?: string;      // "YYYY-MM-DD HH:MM:SS"
  add_time?: string;
  [k: string]: unknown;
}): Promise<PdCreated> {
  return pdRequest<PdCreated>("POST", "/deals", input);
}

export async function updateDeal(id: number, input: Record<string, unknown>): Promise<PdCreated> {
  return pdRequest<PdCreated>("PUT", `/deals/${id}`, input);
}

export async function createActivity(input: {
  subject: string;
  type?: string;
  org_id?: number;
  person_id?: number;
  deal_id?: number;
  /** Assignee — Pipedrive activities use user_id (NOT owner_id, which the
   *  Activities API rejects as an invalid field). */
  user_id?: number;
  due_date?: string;
  note?: string;
  [k: string]: unknown;
}): Promise<PdCreated> {
  return pdRequest<PdCreated>("POST", "/activities", input);
}

export async function updateActivity(id: number, patch: Record<string, unknown>): Promise<PdCreated> {
  return pdRequest<PdCreated>("PUT", `/activities/${id}`, patch);
}

export async function getActivity(id: number): Promise<PdActivity | null> {
  try {
    return await pdRequest<PdActivity>("GET", `/activities/${id}`);
  } catch {
    return null;
  }
}

/**
 * List activities with server-side filters. Pass user_id=0 for ALL users
 * (default is the authenticated user only). Common filters: done (0|1),
 * type (e.g. "call"), start_date/end_date (YYYY-MM-DD, filter by due_date),
 * limit, start (pagination). Returns the flat activity list.
 */
export async function listActivities(params: {
  user_id?: number;
  done?: 0 | 1;
  type?: string;
  start_date?: string;
  end_date?: string;
  limit?: number;
  start?: number;
} = {}): Promise<PdActivity[]> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  const qs = q.toString();
  return (await pdRequest<PdActivity[]>("GET", `/activities${qs ? `?${qs}` : ""}`)) || [];
}

export interface PdMailMessage {
  id?: number;
  from?: Array<{ email_address?: string; name?: string; linked_person_name?: string | null }>;
  to?: Array<{ email_address?: string; name?: string; linked_person_name?: string | null; linked_person_id?: number | null }>;
  subject?: string;
  snippet?: string;
  message_time?: string | number;
  [k: string]: unknown;
}

/** Mail messages associated with a deal (Pipedrive Mailbox). The snippet holds
 *  the opening line — enough to read the "Hi <Name>," greeting we sent. */
export async function listDealMailMessages(dealId: number, limit = 20): Promise<PdMailMessage[]> {
  const raw = (await pdRequest<Array<Record<string, unknown>>>("GET", `/deals/${dealId}/mailMessages?limit=${limit}`)) || [];
  return (Array.isArray(raw) ? raw : []).map((m) => (m.data ?? m) as PdMailMessage);
}

/**
 * Open activities for a person, via the person sub-resource (reliable filtering,
 * unlike /activities?person_id=). Used to close the sequence's "Call" activity
 * when the rep dials the person through PhoneBurner. Sorted by due date ascending.
 */
export async function listOpenActivitiesForPerson(personId: number, limit = 50): Promise<PdActivity[]> {
  const rows = (await pdRequest<PdActivity[]>("GET", `/persons/${personId}/activities?done=0&limit=${limit}`)) || [];
  return rows.slice().sort((a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999"));
}

/** Attach a free-text note to a deal / org / person. */
export async function createNote(input: {
  content: string; // supports basic HTML
  deal_id?: number;
  org_id?: number;
  person_id?: number;
  [k: string]: unknown;
}): Promise<PdCreated> {
  return pdRequest<PdCreated>("POST", "/notes", input);
}

/** Search persons by email/term; returns the first matching person id, or null. */
export async function findPersonIdByEmail(email: string): Promise<number | null> {
  if (!email) return null;
  const r = await pdRequest<{ items?: Array<{ item?: { id?: number } }> }>(
    "GET",
    `/persons/search?term=${encodeURIComponent(email)}&fields=email&exact_match=true&limit=1`,
  );
  return r?.items?.[0]?.item?.id ?? null;
}
