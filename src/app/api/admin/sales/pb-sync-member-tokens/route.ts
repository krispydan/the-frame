export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { phoneBurnerClient } from "@/modules/sales/lib/phoneburner-client";

/**
 * POST /api/admin/sales/pb-sync-member-tokens
 *
 * Pull every workspace member from PB's `/members` endpoint and cache
 * each user's OAuth bearer token to settings, so `phoneBurnerClientFor`
 * picks up the RIGHT credentials per rep. Without this, our client
 * defaults every rep to the admin key (Sandra's), which cannot
 * delete or reassign contacts owned by another rep (Christina).
 *
 * Settings keys populated:
 *   phoneburner_api_key                 → Sandra's token (admin)
 *   phoneburner_api_key_christina       → Christina's token
 *   phoneburner_owner_id                → Sandra's user_id
 *   phoneburner_owner_christina         → Christina's user_id
 *
 * Tokens expire (~few days); re-run periodically or on 401.
 *
 * Body: {} — no params.
 * Auth: x-admin-key: jaxy2026
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const raw = (await phoneBurnerClient.rawGet("/members")) as Record<string, unknown>;
  // /members shape: { members: { members: [[ ...member_objs ]] } } — extra array-nesting
  let membersEnv = raw.members as Record<string, unknown> | undefined;
  let membersRaw = membersEnv?.members as unknown[] | undefined;
  if (Array.isArray(membersRaw) && Array.isArray(membersRaw[0])) {
    membersRaw = membersRaw[0] as unknown[];
  }
  if (!Array.isArray(membersRaw)) {
    return NextResponse.json(
      { ok: false, error: "unexpected /members shape", raw_keys: Object.keys(raw) },
      { status: 500 },
    );
  }

  const upsert = sqlite.prepare(
    `INSERT INTO settings (key, value, type, module, updated_at)
     VALUES (?, ?, 'string', 'phoneburner', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  );

  const stored: Array<{ user: string; id: string; email: string; expires: string; keys_written: string[] }> = [];
  for (const m of membersRaw) {
    const rec = m as Record<string, unknown>;
    const userId = String(rec.user_id || rec.member_user_id || "");
    const email = String(rec.email_address || rec.username || "");
    const oauth = rec.oauth as { bearer_token?: string; expires?: string } | undefined;
    const token = oauth?.bearer_token;
    const expires = oauth?.expires || "";
    if (!userId || !token) continue;

    const written: string[] = [];
    // Sandra = admin (hello@getjaxy.com) → default key
    if (email.toLowerCase().includes("hello@getjaxy")) {
      upsert.run("phoneburner_api_key", token); written.push("phoneburner_api_key");
      upsert.run("phoneburner_owner_id", userId); written.push("phoneburner_owner_id");
    } else if (email.toLowerCase().includes("christina")) {
      upsert.run("phoneburner_api_key_christina", token); written.push("phoneburner_api_key_christina");
      upsert.run("phoneburner_owner_christina", userId); written.push("phoneburner_owner_christina");
    }
    stored.push({ user: `${rec.first_name || ""} ${rec.last_name || ""}`.trim(), id: userId, email, expires, keys_written: written });
  }

  return NextResponse.json({
    ok: true,
    total_members: membersRaw.length,
    stored,
  });
}
