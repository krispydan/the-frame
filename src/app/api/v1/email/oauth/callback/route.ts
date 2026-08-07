export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { exchangeCode, profile } from "@/modules/email/lib/gmail-client";

const APP_BASE =
  process.env.APP_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "https://theframe.getjaxy.com";

function done(msg: string, ok: boolean): NextResponse {
  // Land back on the settings page with the outcome in the query string.
  const url = new URL("/settings/integrations/gmail", APP_BASE);
  url.searchParams.set(ok ? "connected" : "error", msg);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const err = req.nextUrl.searchParams.get("error");
  if (err) return done(err, false);
  if (!code || !state) return done("missing code/state", false);

  // Resolve + consume the one-time state.
  const key = `gmail_oauth_state_${state}`;
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  sqlite.prepare("DELETE FROM settings WHERE key = ?").run(key);
  if (!row) return done("state expired — try connecting again", false);
  const parsed = JSON.parse(row.value) as { userId: string; at: number };
  if (Date.now() - parsed.at > 10 * 60_000) return done("state expired — try connecting again", false);

  const tokens = await exchangeCode(code);
  if (!tokens.access_token) {
    return done(tokens.error_description || tokens.error || "token exchange failed", false);
  }

  const prof = await profile(tokens.access_token);
  const email = prof.ok ? prof.data?.emailAddress?.toLowerCase() : null;
  if (!email) return done("could not read the Gmail address", false);

  const expiresAt = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString();
  const existing = sqlite
    .prepare("SELECT id, refresh_token FROM gmail_connections WHERE user_id = ? AND email = ?")
    .get(parsed.userId, email) as { id: string; refresh_token: string | null } | undefined;

  if (existing) {
    // Google may omit refresh_token on re-consent — keep the one we have.
    sqlite
      .prepare(
        `UPDATE gmail_connections
            SET access_token=?, refresh_token=COALESCE(?, refresh_token), token_expires_at=?,
                status='connected', status_reason=NULL
          WHERE id=?`,
      )
      .run(tokens.access_token, tokens.refresh_token ?? null, expiresAt, existing.id);
  } else {
    sqlite
      .prepare(
        `INSERT INTO gmail_connections (id, user_id, email, access_token, refresh_token, token_expires_at, scopes, status)
         VALUES (?,?,?,?,?,?,?, 'connected')`,
      )
      .run(
        crypto.randomUUID(), parsed.userId, email,
        tokens.access_token, tokens.refresh_token ?? null, expiresAt,
        "gmail.readonly gmail.send",
      );
  }

  return done(email, true);
}
