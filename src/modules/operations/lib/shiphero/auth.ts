/**
 * ShipHero token management.
 *
 * ShipHero access tokens have a ~28-day lifetime. The previous code read the
 * token from process.env.SHIPHERO_ACCESS_TOKEN once at module load, which
 * means every 28 days the integration goes silently dark until someone
 * manually rotates the Railway env var. (See May 29 – June 15 2026 outage.)
 *
 * This module switches the integration to a refresh-token pattern:
 *
 *   shiphero_refresh_token   long-lived (3650 days) — set once via bootstrap
 *   shiphero_access_token    rotated automatically — read live from settings
 *   shiphero_token_expires_at  ISO from the JWT exp claim
 *
 * All three live in the generic `settings` k/v table (no schema change).
 *
 * Lifecycle:
 *   - Bootstrap (one-time): POST /api/admin/shiphero/bootstrap with either
 *     username+password OR an existing refresh token.
 *   - Daily cron `shiphero-token-refresh` calls refreshIfExpiringSoon(7) —
 *     refreshes only when the token is within 7 days of expiry. Quiet on
 *     the other 21 days.
 *   - api-client.ts gql() catches any 401 and calls refreshAccessToken()
 *     once before retrying — self-heals if the token rotates faster than
 *     the cron expects.
 */
import { sqlite } from "@/lib/db";

const REFRESH_URL = "https://public-api.shiphero.com/auth/refresh";
const PASSWORD_GRANT_URL = "https://public-api.shiphero.com/auth/token";

function getSetting(key: string): string | null {
  const row = sqlite
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

function setSetting(key: string, value: string): void {
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, type, module, updated_at)
       VALUES (?, ?, 'string', 'shiphero', datetime('now'))
       ON CONFLICT(key) DO UPDATE
         SET value = excluded.value,
             updated_at = datetime('now')`,
    )
    .run(key, value);
}

/** Decode a JWT's exp claim. Returns null if the token isn't a JWT or has no exp. */
function jwtExp(jwt: string): number | null {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = JSON.parse(Buffer.from(padded, "base64url").toString());
    return typeof json.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}

/**
 * Return a live ShipHero access token. Reads the settings table first
 * (where the refresh cron writes), falls back to env var so an unrotated
 * deploy keeps working during the transition window.
 */
export function getAccessToken(): string | null {
  const fromDb = getSetting("shiphero_access_token");
  if (fromDb) return fromDb;
  return process.env.SHIPHERO_ACCESS_TOKEN || null;
}

function storeAccessToken(accessToken: string): void {
  setSetting("shiphero_access_token", accessToken);
  const exp = jwtExp(accessToken);
  if (exp) {
    setSetting("shiphero_token_expires_at", new Date(exp * 1000).toISOString());
  }
}

/**
 * Mint a fresh access token from the stored refresh token. Throws if no
 * refresh token has been bootstrapped yet.
 */
export async function refreshAccessToken(): Promise<{
  accessToken: string;
  expiresAt: string | null;
}> {
  const refreshToken = getSetting("shiphero_refresh_token");
  if (!refreshToken) {
    throw new Error(
      "No shiphero_refresh_token in settings — bootstrap with POST /api/admin/shiphero/bootstrap first",
    );
  }
  const res = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ShipHero token refresh failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("ShipHero token refresh returned no access_token");
  }
  storeAccessToken(json.access_token);
  return {
    accessToken: json.access_token,
    expiresAt: getSetting("shiphero_token_expires_at"),
  };
}

/**
 * Bootstrap path A — username + password. Calls the public-api password
 * grant, persists both tokens. The refresh token returned by this grant
 * is long-lived (3650 days per ShipHero's docs).
 */
export async function bootstrapWithPassword(opts: {
  username: string;
  password: string;
}): Promise<{ accessToken: string; refreshToken: string; expiresAt: string | null }> {
  const res = await fetch(PASSWORD_GRANT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: opts.username,
      password: opts.password,
      grant_type: "password",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ShipHero password grant failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as { access_token?: string; refresh_token?: string };
  if (!json.access_token || !json.refresh_token) {
    throw new Error("ShipHero password grant returned no tokens");
  }
  setSetting("shiphero_refresh_token", json.refresh_token);
  storeAccessToken(json.access_token);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: getSetting("shiphero_token_expires_at"),
  };
}

/**
 * Bootstrap path B — pass an existing refresh token (from the ShipHero
 * developer portal or a prior password grant). We store it and immediately
 * use it to mint a fresh access token.
 */
export async function bootstrapWithRefreshToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresAt: string | null;
}> {
  setSetting("shiphero_refresh_token", refreshToken);
  return await refreshAccessToken();
}

/**
 * Cron entrypoint. Refresh only if the current access token expires within
 * `daysBeforeExpiry` days. Quiet on other days (returns refreshed=false).
 */
export async function refreshIfExpiringSoon(daysBeforeExpiry = 7): Promise<
  { refreshed: true; expiresAt: string | null } | { refreshed: false; reason: string }
> {
  const expIso = getSetting("shiphero_token_expires_at");
  if (!expIso) {
    // No expiry on record — either first run after bootstrap or settings
    // got cleared. Refresh defensively.
    const r = await refreshAccessToken();
    return { refreshed: true, expiresAt: r.expiresAt };
  }
  const expMs = new Date(expIso).getTime();
  const cutoff = Date.now() + daysBeforeExpiry * 24 * 60 * 60 * 1000;
  if (expMs > cutoff) {
    return { refreshed: false, reason: `Token valid until ${expIso}` };
  }
  const r = await refreshAccessToken();
  return { refreshed: true, expiresAt: r.expiresAt };
}

export function isTokenConfigured(): boolean {
  return !!getAccessToken();
}
