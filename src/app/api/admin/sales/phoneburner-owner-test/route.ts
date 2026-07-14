export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { phoneBurnerClient, pbOwnerFor, type PbRep } from "@/modules/sales/lib/phoneburner-client";

/**
 * POST /api/admin/sales/phoneburner-owner-test?rep=christina
 *
 * Creates ONE throwaway contact with owner_id = the rep's user, via the shared
 * account key, and reports who actually owns it. Settles shared-vs-separate:
 *   - actualOwner == rep's owner  → shared account; create-time owner works, so
 *     the fix is to (re)create the rep's contacts owned by her.
 *   - actualOwner == account owner → the key can't assign to that user (she's a
 *     SEPARATE account) → we need her own API key.
 *
 * Leaves the test contact (named "ZZ Owner Test"); delete it in PhoneBurner
 * afterward. Auth: x-admin-key: jaxy2026.
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rep = (new URL(req.url).searchParams.get("rep") || "christina") as PbRep;
  const requestedOwner = pbOwnerFor(rep);
  if (!requestedOwner) return NextResponse.json({ error: `no owner_id for ${rep}` }, { status: 400 });

  // A phone unlikely to collide, so on_duplicate doesn't merge into an existing.
  const phone = `999${Math.floor(1000000 + Math.random() * 8999999)}`;
  let created: Record<string, unknown>;
  try {
    created = await phoneBurnerClient.createContact({
      owner_id: requestedOwner,
      first_name: "ZZ Owner",
      last_name: "Test",
      phone,
      on_duplicate: "create",
    });
  } catch (e) {
    return NextResponse.json({ error: `create failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }

  function readOwnerId(obj: unknown, depth = 0): string | null {
    if (depth > 6 || !obj || typeof obj !== "object") return null;
    const o = obj as Record<string, unknown>;
    if (o.owner_id != null) return String(o.owner_id);
    for (const v of Object.values(o)) {
      const f = readOwnerId(v, depth + 1);
      if (f) return f;
    }
    return null;
  }
  // Read the contact back (the create response is minimal), so we get the
  // authoritative owner_id.
  const contactId = String(created.id ?? "").replace(/\.0$/, "");
  let actualOwner: string | null = readOwnerId(created);
  if (contactId) {
    try {
      const fetched = await phoneBurnerClient.getContact(contactId);
      actualOwner = readOwnerId(fetched) ?? actualOwner;
    } catch {
      /* keep create-response value */
    }
  }
  const sticks = actualOwner === requestedOwner;

  return NextResponse.json({
    ok: true,
    rep,
    requestedOwner,
    actualOwner,
    accountOwner: pbOwnerFor("sandra"),
    ownerSticksOnCreate: sticks,
    verdict: sticks
      ? "SHARED account — owner works at create. Fix: recreate her contacts owned by her."
      : "Sandra's key CANNOT own contacts as Christina — need Christina's own API key.",
    testContactId: contactId || "(unknown)",
    note: "Delete the 'ZZ Owner Test' contact(s) in PhoneBurner afterward.",
  });
}
