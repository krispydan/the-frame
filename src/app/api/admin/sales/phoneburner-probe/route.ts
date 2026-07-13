export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { phoneBurnerClient } from "@/modules/sales/lib/phoneburner-client";

/**
 * GET /api/admin/sales/phoneburner-probe
 *
 * Read-only scope check for the PhoneBurner account the current API key belongs
 * to: the discovered owner, the team members (if any), and existing folders.
 * Tells us whether Christina is a member of this account (route by owner) or a
 * separate account (needs her own API key). No writes. Auth: x-admin-key.
 */
export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (phoneBurnerClient.isMock) {
    return NextResponse.json({ error: "PhoneBurner not configured — set PHONEBURNER_API_KEY or settings.phoneburner_api_key" }, { status: 400 });
  }

  const currentOwnerId =
    (sqlite.prepare("SELECT value FROM settings WHERE key = 'phoneburner_owner_id' LIMIT 1").get() as { value: string } | undefined)?.value ?? null;

  const [members, folders, membersRaw] = await Promise.all([
    phoneBurnerClient.listMembers().catch((e) => ({ error: e instanceof Error ? e.message : String(e) })),
    phoneBurnerClient.listFolders().catch((e) => ({ error: e instanceof Error ? e.message : String(e) })),
    phoneBurnerClient.membersDiagnostic().catch((e) => ({ error: e instanceof Error ? e.message : String(e) })),
  ]);

  const memberList = Array.isArray(members) ? members : members;
  return NextResponse.json({
    ok: true,
    currentOwnerId,
    teamMembers: memberList,
    memberCount: Array.isArray(members) ? members.length : "unavailable",
    membersDiagnostic: membersRaw,
    folders: Array.isArray(folders) ? folders.map((f) => ({ id: f.id, name: f.name })) : folders,
    interpretation:
      Array.isArray(members) && members.length > 1
        ? "Team account — multiple members. Christina/Sandra can be routed by owner_id with one key (Scenario A)."
        : "Single member (or no members endpoint). If Christina is a separate account, we need her own API key (Scenario B).",
  });
}
