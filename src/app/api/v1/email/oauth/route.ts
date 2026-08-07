export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { getSessionUser } from "@/lib/get-session";
import { authUrl } from "@/modules/email/lib/gmail-client";

/**
 * GET → redirect the signed-in user to Google's consent screen.
 *
 * The OAuth `state` is a one-time row in settings (not in-memory — a deploy
 * mid-flow would strand the callback) mapping state → user id, 10-min TTL.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const state = crypto.randomUUID();
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, type, module, updated_at)
       VALUES (?, ?, 'string', 'email', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(`gmail_oauth_state_${state}`, JSON.stringify({ userId: user.id, at: Date.now() }));

  const url = authUrl(state);
  if (!url) {
    return NextResponse.json(
      { error: "Gmail OAuth app not configured — set the client ID and secret in Settings → Integrations → Gmail" },
      { status: 400 },
    );
  }
  return NextResponse.redirect(url);
}
