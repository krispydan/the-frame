export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { phoneBurnerClientFor, pbOwnerFor, PB_ACCOUNTS, type PbRep } from "@/modules/sales/lib/phoneburner-client";

/**
 * PhoneBurner second-caller setup.
 *
 * GET  → configured status for both accounts (key present? owner known?), no
 *        secrets leaked.
 * POST → save a rep's API key (and optional username), verify it, and try to
 *        discover the owner_id. Body: { rep?: "christina", apiKey, username? }.
 *        Christina is a SEPARATE account from Sandra (the existing default).
 *
 *   curl -X POST ".../phoneburner-setup" -H "x-admin-key: jaxy2026" \
 *     -H "content-type: application/json" \
 *     -d '{"rep":"christina","apiKey":"<her key>","username":"<her PB username>"}'
 *
 * Auth: x-admin-key: jaxy2026.
 */

function getSetting(key: string): string | null {
  return (sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
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
function deleteSetting(key: string): void {
  sqlite.prepare("DELETE FROM settings WHERE key = ?").run(key);
}
function accountStatus() {
  const rows: Record<string, unknown> = {};
  for (const rep of Object.keys(PB_ACCOUNTS) as PbRep[]) {
    const cfg = PB_ACCOUNTS[rep];
    rows[rep] = {
      keyConfigured: rep === "sandra" ? !!(process.env.PHONEBURNER_API_KEY || getSetting(cfg.keySetting)) : !!getSetting(cfg.keySetting),
      ownerId: getSetting(cfg.ownerSetting),
      username: getSetting(`phoneburner_username_${rep}`),
    };
  }
  return rows;
}

export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, accounts: accountStatus() });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { rep?: string; apiKey?: string; ownerId?: string; username?: string };
  const rep = (body.rep || "christina") as PbRep;
  if (!PB_ACCOUNTS[rep]) return NextResponse.json({ error: `unknown rep "${rep}"` }, { status: 400 });
  const cfg = PB_ACCOUNTS[rep];

  // Two ways a second caller can exist:
  //   (a) same shared account, distinguished by owner_id (the common case) —
  //       provide ownerId (their PhoneBurner user id).
  //   (b) a genuinely separate account with its own token — provide apiKey.
  // A numeric "apiKey" is really a user_id (PB tokens aren't short digit
  // strings), so we auto-correct it to ownerId and keep the shared key.
  let ownerId = (body.ownerId || "").trim() || null;
  let apiKey = (body.apiKey || "").trim() || null;
  if (apiKey && /^\d{5,12}$/.test(apiKey)) {
    ownerId = ownerId || apiKey;
    apiKey = null;
  }
  if (!ownerId && !apiKey) {
    return NextResponse.json({ error: "provide ownerId (shared account) or apiKey (separate account)" }, { status: 400 });
  }

  if (apiKey) setSetting(cfg.keySetting, apiKey);
  else deleteSetting(cfg.keySetting); // shared account — no per-rep key
  if (ownerId) setSetting(cfg.ownerSetting, ownerId);
  if (body.username) setSetting(`phoneburner_username_${rep}`, body.username.trim());

  // Verify with the client that will actually be used (shared key unless a
  // separate key was set).
  const client = phoneBurnerClientFor(rep);
  const probe = await client.authProbe().catch((e) => ({ ok: false, raw: e instanceof Error ? e.message : String(e) }));

  return NextResponse.json({
    ok: probe.ok,
    rep,
    mode: apiKey ? "separate_account" : "shared_account_owner_routing",
    ownerId: pbOwnerFor(rep),
    authOk: probe.ok,
    accounts: accountStatus(),
    note: probe.ok
      ? "Ready — contacts route to this rep by owner_id on the shared account."
      : "Saved, but the shared account key failed auth — check the existing PHONEBURNER_API_KEY.",
  });
}
