export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { phoneBurnerClient } from "@/modules/sales/lib/phoneburner-client";

/**
 * GET /api/admin/phoneburner/contact-dump?contactId=1291623115
 *
 * Dumps the raw PhoneBurner contact so we can see where the per-phone
 * `phoneId` (for the click-to-call c2c URL) lives in the response.
 * Investigation-only. Auth: x-admin-key: jaxy2026
 */
export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const id = new URL(req.url).searchParams.get("contactId");
  if (!id) return NextResponse.json({ error: "contactId required" }, { status: 400 });
  try {
    const raw = await phoneBurnerClient.getContact(id);
    // Surface likely phone-id locations for quick reading.
    const r = raw as Record<string, unknown>;
    const contact = (r.contact ?? r) as Record<string, unknown>;
    return NextResponse.json({
      ok: true,
      contactId: id,
      phones_field: contact.phones ?? contact.phone ?? null,
      top_level_keys: Object.keys(r),
      contact_keys: Object.keys(contact),
      raw,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
