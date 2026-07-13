export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { phoneBurnerClientFor, PB_ACCOUNTS, type PbRep } from "@/modules/sales/lib/phoneburner-client";

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
  const body = (await req.json().catch(() => ({}))) as { rep?: string; apiKey?: string; username?: string };
  const rep = (body.rep || "christina") as PbRep;
  if (!PB_ACCOUNTS[rep]) return NextResponse.json({ error: `unknown rep "${rep}"` }, { status: 400 });
  if (!body.apiKey || body.apiKey.trim().length < 8) return NextResponse.json({ error: "apiKey required" }, { status: 400 });

  const cfg = PB_ACCOUNTS[rep];
  setSetting(cfg.keySetting, body.apiKey.trim());
  if (body.username) setSetting(`phoneburner_username_${rep}`, body.username.trim());

  // Verify the key works, then try to discover the owner_id (may be null on a
  // brand-new empty account — the push falls back to owner_username until a
  // contact exists to read owner_id from).
  const client = phoneBurnerClientFor(rep);
  const probe = await client.authProbe().catch((e) => ({ ok: false, raw: e instanceof Error ? e.message : String(e) }));
  let ownerId: string | null = null;
  if (probe.ok) {
    ownerId = await client.discoverOwnerId().catch(() => null);
    if (ownerId) setSetting(cfg.ownerSetting, ownerId);
  }

  return NextResponse.json({
    ok: probe.ok,
    rep,
    keySaved: true,
    authOk: probe.ok,
    ownerId,
    ownerNote: ownerId ? "discovered + saved" : "not discovered yet (empty account) — push will use owner_username until a contact exists",
    accounts: accountStatus(),
  });
}
