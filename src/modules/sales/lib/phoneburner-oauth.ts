import { sqlite } from "@/lib/db";
import { PhoneBurnerClient, PB_ACCOUNTS, type PbRep } from "@/modules/sales/lib/phoneburner-client";

/**
 * PhoneBurner OAuth 2.0 authorization-code flow (per rep).
 *
 * PhoneBurner's REST API is OAuth2-only and its access tokens EXPIRE (they
 * arrive with a refresh_token). A hand-pasted token therefore can't work — the
 * account has to go through authorize → code → token exchange, and we must keep
 * the refresh_token so the access token can be renewed before it lapses.
 *
 * Endpoints (verified against PhoneBurner developer docs, 2026-07):
 *   authorize:  https://www.phoneburner.com/oauth/authorize
 *   token:      https://www.phoneburner.com/oauth/accesstoken   (code + refresh)
 *
 * Per-rep settings written here:
 *   phoneburner_client_id_<rep>      OAuth app client id
 *   phoneburner_client_secret_<rep>  OAuth app client secret
 *   <keySetting>                     access token (e.g. phoneburner_api_key_christina)
 *   phoneburner_refresh_token_<rep>  refresh token
 *   phoneburner_token_expires_<rep>  epoch ms when the access token expires
 *   <ownerSetting>                   discovered owner user_id
 */

export const PB_AUTHORIZE_URL = "https://www.phoneburner.com/oauth/authorize";
export const PB_TOKEN_URL = "https://www.phoneburner.com/oauth/accesstoken";

/** The redirect_uri must match EXACTLY across app registration, the authorize
 *  request, and the token exchange. Keep it stable. */
/**
 * Base URL for the OAuth redirect. This MUST equal the host registered as the
 * app's Authorization callback URL in PhoneBurner, or the token exchange 400s on
 * a redirect_uri mismatch. The registered callback is
 * https://theframe.getjaxy.com/api/auth/phoneburner/callback, so we pin to that
 * host by default and only honor an explicit PHONEBURNER_APP_URL override (not
 * the generic Shopify/Pipedrive app-url vars, which may point at a railway.app
 * domain that wouldn't match the registration).
 */
export function pbAppBaseUrl(): string {
  return (process.env.PHONEBURNER_APP_URL || "https://theframe.getjaxy.com").replace(/\/$/, "");
}
export function pbRedirectUri(): string {
  return `${pbAppBaseUrl()}/api/auth/phoneburner/callback`;
}
/** The URL a rep visits to START the flow (sets the CSRF state cookie, then
 *  bounces to PhoneBurner's authorize page). */
export function pbInitiateUrl(rep: PbRep): string {
  return `${pbAppBaseUrl()}/api/auth/phoneburner?rep=${rep}`;
}

function getSetting(key: string): string | null {
  return (sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value?.trim() || null;
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

export function pbClientId(rep: PbRep): string | null {
  return getSetting(`phoneburner_client_id_${rep}`);
}
export function pbClientSecret(rep: PbRep): string | null {
  return getSetting(`phoneburner_client_secret_${rep}`);
}
export function setPbClientCreds(rep: PbRep, clientId: string, clientSecret: string): void {
  setSetting(`phoneburner_client_id_${rep}`, clientId.trim());
  setSetting(`phoneburner_client_secret_${rep}`, clientSecret.trim());
}

/** Build the authorize URL a rep visits in their browser to grant access. */
export function pbAuthorizeUrl(rep: PbRep, state: string): string {
  const clientId = pbClientId(rep);
  if (!clientId) throw new Error(`no client_id for ${rep} — POST it to /phoneburner-setup first`);
  const u = new URL(PB_AUTHORIZE_URL);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", pbRedirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  return u.toString();
}

type TokenResponse = {
  access_token?: string;
  token_type?: string;
  expires?: number | string;
  expires_in?: number | string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
};

async function postToken(form: Record<string, string>): Promise<TokenResponse> {
  const body = new URLSearchParams(form).toString();
  const res = await fetch(PB_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const text = await res.text();
  let json: TokenResponse = {};
  try {
    json = text ? (JSON.parse(text) as TokenResponse) : {};
  } catch {
    throw new Error(`PhoneBurner token endpoint ${res.status}: ${text.slice(0, 400)}`);
  }
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(`PhoneBurner token exchange failed (${res.status}): ${json.error_description || json.error || text.slice(0, 400)}`);
  }
  return json;
}

function persistTokens(rep: PbRep, tok: TokenResponse): void {
  const cfg = PB_ACCOUNTS[rep];
  if (tok.access_token) setSetting(cfg.keySetting, tok.access_token);
  if (tok.refresh_token) setSetting(`phoneburner_refresh_token_${rep}`, tok.refresh_token);
  const expiresInSec = Number(tok.expires_in) || (Number(tok.expires) ? Number(tok.expires) * 1000 - Date.now() : 0);
  if (expiresInSec > 0) {
    setSetting(`phoneburner_token_expires_${rep}`, String(Date.now() + expiresInSec * (Number(tok.expires_in) ? 1000 : 1)));
  }
}

/** Exchange an authorization code for tokens and persist them. Also discovers
 *  and stores the rep's owner user_id. Returns a small status summary. */
export async function exchangePhoneBurnerCode(rep: PbRep, code: string): Promise<{ ownerId: string | null; expiresAt: string | null }> {
  const clientId = pbClientId(rep);
  const clientSecret = pbClientSecret(rep);
  if (!clientId || !clientSecret) throw new Error(`missing client_id/client_secret for ${rep}`);
  const tok = await postToken({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: pbRedirectUri(),
    code,
  });
  persistTokens(rep, tok);

  // Discover the owner user_id with the fresh token so folders/contacts assign
  // to the right user. Best-effort — a brand-new account with no contacts yet
  // returns null; the first created contact backfills it later.
  let ownerId: string | null = null;
  try {
    const client = new PhoneBurnerClient({ apiKey: tok.access_token!, label: rep });
    ownerId = await client.discoverOwnerId();
    if (ownerId) setSetting(PB_ACCOUNTS[rep].ownerSetting, ownerId);
  } catch {
    /* ignore — owner backfills on first contact create */
  }
  const expiresRaw = getSetting(`phoneburner_token_expires_${rep}`);
  return { ownerId, expiresAt: expiresRaw ? new Date(Number(expiresRaw)).toISOString() : null };
}

/** Refresh the access token if it's missing or within `skewMs` of expiry.
 *  Returns the current (possibly refreshed) access token, or null if we can't
 *  refresh (no refresh token / creds). Safe to call before any PB request. */
export async function ensureFreshPhoneBurnerToken(rep: PbRep, skewMs = 5 * 60_000): Promise<string | null> {
  const cfg = PB_ACCOUNTS[rep];
  const current = getSetting(cfg.keySetting);
  const expiresAt = Number(getSetting(`phoneburner_token_expires_${rep}`)) || 0;
  const refreshToken = getSetting(`phoneburner_refresh_token_${rep}`);
  const clientId = pbClientId(rep);
  const clientSecret = pbClientSecret(rep);

  const stillValid = current && expiresAt && expiresAt - Date.now() > skewMs;
  if (stillValid) return current;
  if (!refreshToken || !clientId || !clientSecret) return current; // nothing to refresh with

  const tok = await postToken({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
  persistTokens(rep, tok);
  return tok.access_token || current;
}

/** Status view for diagnostics (no secrets). */
export function pbOAuthStatus(rep: PbRep) {
  const expiresAt = Number(getSetting(`phoneburner_token_expires_${rep}`)) || 0;
  return {
    clientIdConfigured: !!pbClientId(rep),
    clientSecretConfigured: !!pbClientSecret(rep),
    accessTokenConfigured: !!getSetting(PB_ACCOUNTS[rep].keySetting),
    refreshTokenConfigured: !!getSetting(`phoneburner_refresh_token_${rep}`),
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    expired: expiresAt ? expiresAt < Date.now() : null,
    redirectUri: pbRedirectUri(),
  };
}
