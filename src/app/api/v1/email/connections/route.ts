export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { getSessionUser } from "@/lib/get-session";
import { oauthCreds } from "@/modules/email/lib/gmail-client";

/** GET → this user's connection + whether the OAuth app is configured. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const conn = sqlite
    .prepare(
      `SELECT id, email, status, status_reason, last_synced_at, created_at
         FROM gmail_connections WHERE user_id = ? AND status != 'disconnected' LIMIT 1`,
    )
    .get(user.id) ?? null;

  return NextResponse.json({ ok: true, configured: !!oauthCreds(), connection: conn });
}

/** DELETE → disconnect (tokens cleared; threads/messages already synced stay). */
export async function DELETE(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  sqlite
    .prepare(
      `UPDATE gmail_connections
          SET status='disconnected', access_token=NULL, refresh_token=NULL, status_reason='disconnected by user'
        WHERE id = ? AND user_id = ?`,
    )
    .run(id, user.id);
  return NextResponse.json({ ok: true });
}
