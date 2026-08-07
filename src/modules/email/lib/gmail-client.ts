/**
 * Gmail API client: OAuth per rep, token refresh, incremental read sync
 * surface, and send.
 *
 * OAuth app credentials live in settings (`gmail_oauth_client_id` /
 * `gmail_oauth_client_secret`, env fallback GOOGLE_OAUTH_CLIENT_ID/SECRET) —
 * same pattern as the other integrations, so they're configurable from the
 * settings UI without a deploy.
 *
 * Scopes: gmail.readonly + gmail.send. These are restricted scopes; with the
 * OAuth consent screen in "testing" mode and our three users on the test-user
 * list, no Google verification is needed. The consent screen shows an
 * "unverified app" interstitial once per connect — acceptable for an internal
 * tool, documented on the settings page.
 */

import { sqlite } from "@/lib/db";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

function getSetting(key: string): string | null {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = ? LIMIT 1").get(key) as
    | { value: string | null }
    | undefined;
  return row?.value?.trim() || null;
}

export function oauthCreds(): { clientId: string; clientSecret: string } | null {
  const clientId = getSetting("gmail_oauth_client_id") || process.env.GOOGLE_OAUTH_CLIENT_ID || null;
  const clientSecret = getSetting("gmail_oauth_client_secret") || process.env.GOOGLE_OAUTH_CLIENT_SECRET || null;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function redirectUri(): string {
  const base =
    process.env.APP_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "https://theframe.getjaxy.com";
  return `${base.replace(/\/$/, "")}/api/v1/email/oauth/callback`;
}

export function authUrl(state: string): string | null {
  const creds = oauthCreds();
  if (!creds) return null;
  const p = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    // Force the consent screen so we ALWAYS get a refresh_token — Google
    // omits it on re-consent otherwise, and a connection without one dies
    // in an hour.
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${p.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export async function exchangeCode(code: string): Promise<TokenResponse> {
  const creds = oauthCreds();
  if (!creds) return { error: "not_configured" };
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });
  return (await res.json()) as TokenResponse;
}

export interface GmailConnection {
  id: string;
  user_id: string;
  email: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  status: string;
  history_cursor: string | null;
}

export function connectionForUser(userId: string): GmailConnection | null {
  return (sqlite
    .prepare("SELECT * FROM gmail_connections WHERE user_id = ? AND status != 'disconnected' LIMIT 1")
    .get(userId) as GmailConnection | undefined) ?? null;
}

export function connectionById(id: string): GmailConnection | null {
  return (sqlite.prepare("SELECT * FROM gmail_connections WHERE id = ?").get(id) as GmailConnection | undefined) ?? null;
}

/**
 * A valid access token for the connection, refreshing if within 2 minutes of
 * expiry. A refresh failure marks the connection needs_reconnect — the send
 * and sync paths treat that as "stop, tell the human", never retry-loop.
 */
export async function accessTokenFor(conn: GmailConnection): Promise<
  { ok: true; token: string } | { ok: false; reason: string }
> {
  const expiresAt = conn.token_expires_at ? Date.parse(conn.token_expires_at) : 0;
  if (conn.access_token && expiresAt > Date.now() + 120_000) {
    return { ok: true, token: conn.access_token };
  }
  if (!conn.refresh_token) return { ok: false, reason: "no refresh token — reconnect the account" };

  const creds = oauthCreds();
  if (!creds) return { ok: false, reason: "Gmail OAuth app not configured" };

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: conn.refresh_token,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json()) as TokenResponse;
  if (!data.access_token) {
    sqlite
      .prepare("UPDATE gmail_connections SET status = 'needs_reconnect', status_reason = ? WHERE id = ?")
      .run(data.error_description || data.error || "token refresh failed", conn.id);
    return { ok: false, reason: data.error_description || data.error || "token refresh failed" };
  }
  const newExpiry = new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString();
  sqlite
    .prepare("UPDATE gmail_connections SET access_token = ?, token_expires_at = ?, status = 'connected', status_reason = NULL WHERE id = ?")
    .run(data.access_token, newExpiry, conn.id);
  return { ok: true, token: data.access_token };
}

// ── Thin API wrappers. Non-OK responses come back as {error} with status so
//    callers can distinguish auth (reconnect) from rate limit (retry later). ──

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

async function api<T>(token: string, path: string, params?: Record<string, string>): Promise<ApiResult<T>> {
  const url = new URL(`${GMAIL}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: text.slice(0, 400) };
  }
  return { ok: true, status: res.status, data: (await res.json()) as T };
}

export function profile(token: string) {
  return api<{ emailAddress?: string; historyId?: string }>(token, "/profile");
}

export function listHistory(token: string, startHistoryId: string, pageToken?: string) {
  return api<{
    history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }>;
    historyId?: string;
    nextPageToken?: string;
  }>(token, "/history", {
    startHistoryId,
    historyTypes: "messageAdded",
    maxResults: "500",
    ...(pageToken ? { pageToken } : {}),
  });
}

export function getMessage(token: string, id: string) {
  return api<{
    id?: string;
    threadId?: string;
    snippet?: string;
    internalDate?: string;
    labelIds?: string[];
    payload?: import("./mime").GmailPart;
  }>(token, `/messages/${id}`, { format: "full" });
}

export function getAttachment(token: string, messageId: string, attachmentId: string) {
  return api<{ data?: string; size?: number }>(token, `/messages/${messageId}/attachments/${attachmentId}`);
}

export async function sendRaw(token: string, raw: string, threadId?: string | null): Promise<ApiResult<{ id?: string; threadId?: string }>> {
  const res = await fetch(`${GMAIL}/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: text.slice(0, 400) };
  }
  return { ok: true, status: res.status, data: (await res.json()) as { id?: string; threadId?: string } };
}
