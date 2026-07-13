export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { phoneBurnerClient, pbOwnerFor, type PbRep } from "@/modules/sales/lib/phoneburner-client";

/**
 * GET /api/admin/sales/phoneburner-verify-owner?rep=christina&n=5
 *
 * Reads back a few of the rep's staged PhoneBurner contacts (from pb_call_queue
 * for their folder) and reports each contact's actual owner_id, so we can
 * confirm the re-assignment took (PhoneBurner may ignore owner_id on update).
 * Auth: x-admin-key: jaxy2026.
 */

/** Walk a PB contact record for its owner_id (shape varies). */
function readOwnerId(obj: unknown, depth = 0): string | null {
  if (depth > 6 || !obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.owner_id != null) return String(o.owner_id);
  if (o.user_id != null && depth === 0) {
    // some shapes nest the real record; keep looking but remember nothing yet
  }
  for (const v of Object.values(o)) {
    const found = readOwnerId(v, depth + 1);
    if (found) return found;
  }
  return null;
}

export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const rep = (url.searchParams.get("rep") || "christina") as PbRep;
  const n = Math.min(20, Math.max(1, parseInt(url.searchParams.get("n") || "5", 10)));
  const expectedOwner = pbOwnerFor(rep);

  const folderId = (sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(`pb_daily_folder_${rep}`) as { value: string } | undefined)?.value ?? null;
  if (!folderId) return NextResponse.json({ error: `no daily folder for ${rep}` }, { status: 400 });

  const rows = sqlite
    .prepare("SELECT pb_contact_id, company_id FROM pb_call_queue WHERE folder_id = ? LIMIT ?")
    .all(folderId, n) as Array<{ pb_contact_id: string; company_id: string }>;

  const contacts: Array<{ pbContactId: string; ownerId: string | null; ownedByRep: boolean; error?: string }> = [];
  for (const r of rows) {
    try {
      const c = await phoneBurnerClient.getContact(r.pb_contact_id);
      const ownerId = readOwnerId(c);
      contacts.push({ pbContactId: r.pb_contact_id, ownerId, ownedByRep: !!ownerId && ownerId === expectedOwner });
    } catch (e) {
      contacts.push({ pbContactId: r.pb_contact_id, ownerId: null, ownedByRep: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const owned = contacts.filter((c) => c.ownedByRep).length;
  return NextResponse.json({
    ok: true,
    rep,
    folderId,
    expectedOwner,
    checked: contacts.length,
    ownedByRep: owned,
    verdict:
      contacts.length === 0
        ? "no queued contacts to check"
        : owned === contacts.length
          ? "OK — contacts are owned by the rep"
          : owned === 0
            ? "PROBLEM — none owned by the rep (owner_id update likely ignored on PUT)"
            : "PARTIAL — some not owned by the rep",
    contacts,
  });
}
