/**
 * PhoneBurner OAuth2 (authorization_code + refresh_token).
 *
 * PhoneBurner has no client-credentials grant, so each PhoneBurner account
 * (Sandra, Christina) must authorize the shared app ONCE. We then hold a
 * refresh token and renew the access token forever without re-consent.
 *
 * Endpoints (per PB docs):
 *   authorize:  https://www.phoneburner.com/oauth/authorize
 *   token:      https://www.phoneburner.com/oauth/accesstoken
 *   refresh:    https://www.phoneburner.com/oauth/refreshtoken
 *
 * The current access token is stored in the SAME settings key the per-rep
 * PhoneBurnerClient already reads (`phoneburner_api_key_<rep>`), so no call
 * site changes are needed. Refresh state lives in `phoneburner_oauth_<rep>`.
 */
import { sqlite } from "@/lib/db";

const AUTHORIZE_URL = "https://www.phoneburner.com/oauth/authorize";
const TOKEN_URL = "https://www.phoneburner.com/oauth/accesstoken";
const REFRESH_URL = "https://www.phoneburner.com/oauth/refreshtoken";
const DEFAULT_REDIRECT = "https://theframe.getjaxy.com/api/auth/phoneburner/callback";

export type PbRep = "sandra" | "christina" | "default";

function getSetting(key: string): string | null {
  const r = sqlite.prepare("SELECT value FROM settings WHERE key = ? LIMIT 1").get(key) as
    | { value: string | null } | undefined;
  return r?.value ?? null;
}
function setSetting(key: string, value: string): void {
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, type, module, updated_at)
       VALUES (?, ?, 'string', 'phoneburner', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(key, value);
}

/** Settings key the per-rep PhoneBurnerClient reads for its Bearer token. */
function apiKeySetting(rep: PbRep): string {
  return rep === "default" || rep === "sandra" ? "phoneburner_api_key" : `phoneburner_api_key_${rep}`;
}
function oauthStateSetting(rep: PbRep): string {
  return `phoneburner_oauth_${rep}`;
}

export interface PbOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}
export function getOAuthConfig(): PbOAuthConfig | null {
  const clientId = getSetting("phoneburner_oauth_client_id");
  const clientSecret = getSetting("phoneburner_oauth_client_secret");
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: getSetting("phoneburner_oauth_redirect_uri") || DEFAULT_REDIRECT };
}
export function setOAuthConfig(clientId: string, clientSecret: string, redirectUri?: string): void {
  setSetting("phoneburner_oauth_client_id", clientId.trim());
  setSetting("phoneburner_oauth_client_secret", clientSecret.trim());
  setSetting("phoneburner_oauth_redirect_uri", (redirectUri || DEFAULT_REDIRECT).trim());
}

/** Build the URL a rep opens (logged into THAT PhoneBurner account) to consent. */
export function buildAuthorizeUrl(rep: PbRep): string | null {
  const cfg = getOAuthConfig();
  if (!cfg) return null;
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    state: rep,
  });
  return `${AUTHORIZE_URL}?${p.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  [k: string]: unknown;
}

function persistTokens(rep: PbRep, t: TokenResponse): void {
  if (t.access_token) setSetting(apiKeySetting(rep), t.access_token);
  const expiresAt = t.expires_in ? Date.now() + t.expires_in * 1000 : Date.now() + 3600_000;
  setSetting(
    oauthStateSetting(rep),
    JSON.stringify({
      refresh_token: t.refresh_token ?? (readOAuthState(rep)?.refresh_token ?? null),
      expires_at: expiresAt,
      connected_at: new Date().toISOString(),
    }),
  );
}
function readOAuthState(rep: PbRep): { refresh_token: string | null; expires_at: number } | null {
  const raw = getSetting(oauthStateSetting(rep));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Exchange an authorization code for tokens and persist them for a rep. */
export async function exchangeCode(rep: PbRep, code: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = getOAuthConfig();
  if (!cfg) return { ok: false, error: "PhoneBurner OAuth app not configured" };
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: cfg.redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `token exchange ${res.status}: ${text.slice(0, 300)}` };
  let json: TokenResponse;
  try { json = JSON.parse(text); } catch { return { ok: false, error: `bad token response: ${text.slice(0, 200)}` }; }
  if (!json.access_token) return { ok: false, error: `no access_token in response: ${text.slice(0, 200)}` };
  persistTokens(rep, json);
  return { ok: true };
}

/** Refresh a rep's access token using the stored refresh token. */
export async function refreshRep(rep: PbRep): Promise<{ ok: boolean; error?: string }> {
  const cfg = getOAuthConfig();
  if (!cfg) return { ok: false, error: "not configured" };
  const st = readOAuthState(rep);
  if (!st?.refresh_token) return { ok: false, error: "no refresh token" };
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: st.refresh_token,
    grant_type: "refresh_token",
    redirect_uri: cfg.redirectUri,
  });
  const res = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `refresh ${res.status}: ${text.slice(0, 200)}` };
  try {
    const json = JSON.parse(text) as TokenResponse;
    if (!json.access_token) return { ok: false, error: "no access_token on refresh" };
    persistTokens(rep, json);
    return { ok: true };
  } catch { return { ok: false, error: `bad refresh response: ${text.slice(0, 200)}` }; }
}

/** Refresh any rep tokens within `withinMs` of expiry. Cron entrypoint. */
export async function refreshExpiringTokens(withinMs = 20 * 60_000): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const rep of ["christina", "sandra"] as PbRep[]) {
    const st = readOAuthState(rep);
    if (!st?.refresh_token) { out[rep] = "no oauth"; continue; }
    if (Date.now() < st.expires_at - withinMs) { out[rep] = "still fresh"; continue; }
    out[rep] = (await refreshRep(rep)).ok ? "refreshed" : "refresh failed";
  }
  return out;
}

export function oauthStatus(): Record<string, unknown> {
  const cfg = getOAuthConfig();
  const rep = (r: PbRep) => {
    const st = readOAuthState(r);
    return {
      connected: !!getSetting(apiKeySetting(r)),
      has_refresh: !!st?.refresh_token,
      expires_at: st?.expires_at ? new Date(st.expires_at).toISOString() : null,
    };
  };
  return { app_configured: !!cfg, redirect_uri: cfg?.redirectUri ?? DEFAULT_REDIRECT, christina: rep("christina"), sandra: rep("sandra") };
}
