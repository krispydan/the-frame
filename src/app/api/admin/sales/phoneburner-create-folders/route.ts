export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { phoneBurnerClientFor, pbOwnerFor, PB_ACCOUNTS, type PbRep } from "@/modules/sales/lib/phoneburner-client";

/**
 * POST /api/admin/sales/phoneburner-create-folders?rep=christina
 *
 * Creates a rep's PhoneBurner folders on the shared account, OWNED BY THAT REP's
 * owner_id, and wires the ids into settings so Model A (daily calling) and the
 * Faire push use them:
 *   - "<Name> - Daily Calls"        → settings.pb_daily_folder_<rep>
 *   - "<Name> - AJM Faire Market"   → settings.faire_pb_folder_<rep>
 *
 * Idempotent: reuses an existing same-named folder, or the id already in
 * settings. Requires the rep's owner_id (run /phoneburner-setup first).
 *
 * GET → current folder settings for both reps. Auth: x-admin-key: jaxy2026.
 */

const REP_LABELS: Record<PbRep, string> = { sandra: "Sandra", christina: "Christina" };

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

export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const view: Record<string, unknown> = {};
  for (const rep of Object.keys(PB_ACCOUNTS) as PbRep[]) {
    view[rep] = {
      ownerId: pbOwnerFor(rep),
      dailyFolder: getSetting(`pb_daily_folder_${rep}`),
      faireFolder: getSetting(`faire_pb_folder_${rep}`),
    };
  }
  return NextResponse.json({ ok: true, folders: view });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const rep = (url.searchParams.get("rep") || "christina") as PbRep;
  // force=true ignores the cached folder-id setting and recreates/matches in the
  // account the rep's key now points at (used when a rep moved to their own key).
  const force = url.searchParams.get("force") === "true";
  if (!PB_ACCOUNTS[rep]) return NextResponse.json({ error: `unknown rep "${rep}"` }, { status: 400 });

  const client = phoneBurnerClientFor(rep);
  if (client.isMock) return NextResponse.json({ error: "PhoneBurner account key not configured" }, { status: 400 });
  const ownerId = pbOwnerFor(rep);
  if (!ownerId) {
    return NextResponse.json({ error: `no owner_id for ${rep} — run /phoneburner-setup first` }, { status: 400 });
  }

  const label = REP_LABELS[rep];
  const wanted: Array<{ setting: string; name: string }> = [
    { setting: `pb_daily_folder_${rep}`, name: `${label} - Daily Calls` },
    { setting: `faire_pb_folder_${rep}`, name: `${label} - AJM Faire Market` },
  ];

  let existing: Array<{ id: string; name: string }> = [];
  try {
    existing = (await client.listFolders()).map((f) => ({ id: f.id, name: f.name || "" }));
  } catch (e) {
    // 200 (not 502) so the edge doesn't mask the real PhoneBurner error.
    return NextResponse.json({ ok: false, step: "listFolders", account: client.label, error: e instanceof Error ? e.message : String(e) });
  }

  const result: Array<{ name: string; setting: string; folderId: string; action: "existing_setting" | "matched_name" | "created" }> = [];
  for (const w of wanted) {
    const cached = getSetting(w.setting);
    if (cached && !force) {
      result.push({ name: w.name, setting: w.setting, folderId: cached, action: "existing_setting" });
      continue;
    }
    const match = existing.find((f) => f.name.trim().toLowerCase() === w.name.toLowerCase());
    if (match) {
      setSetting(w.setting, match.id);
      result.push({ name: w.name, setting: w.setting, folderId: match.id, action: "matched_name" });
      continue;
    }
    try {
      const created = await client.createFolder({ folder_name: w.name, owner_id: ownerId });
      setSetting(w.setting, created.id);
      result.push({ name: w.name, setting: w.setting, folderId: created.id, action: "created" });
    } catch (e) {
      return NextResponse.json({ ok: false, step: "createFolder", account: client.label, folder: w.name, error: e instanceof Error ? e.message : String(e), partial: result });
    }
  }

  return NextResponse.json({ ok: true, rep, account: client.label, ownerId, folders: result });
}
