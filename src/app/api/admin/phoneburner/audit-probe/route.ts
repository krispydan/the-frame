export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { phoneBurnerClientFor, type PbRep } from "@/modules/sales/lib/phoneburner-client";

/**
 * GET /api/admin/phoneburner/audit-probe?contactId=1294227130&rep=christina
 *
 * Discovery-only: tries candidate PhoneBurner "contact audit log / history"
 * routes with the rep's token and reports which respond, so we can wire the
 * contact-edit reconciliation poller to the real endpoint. Auth: x-admin-key.
 */
export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const rep = (url.searchParams.get("rep") || "christina") as PbRep;
  const contactId = url.searchParams.get("contactId") || "";
  const client = phoneBurnerClientFor(rep);

  const candidates: Array<{ path: string; query?: Record<string, string | number> }> = [
    { path: `/contacts/${contactId}/audit` },
    { path: `/contacts/${contactId}/history` },
    { path: `/contacts/${contactId}/activity` },
    { path: `/contacts/${contactId}/activities` },
    { path: `/contacts/${contactId}/auditlog` },
    { path: `/audit`, query: { contact_id: contactId } },
    { path: `/audit/contacts`, query: { contact_id: contactId } },
    { path: `/contacts/audit`, query: { contact_id: contactId } },
    { path: `/contacts`, query: { updated_since: "2026-07-01", page_size: 1 } },
  ];

  const results: Array<{ path: string; ok: boolean; sample?: unknown; error?: string }> = [];
  for (const c of candidates) {
    try {
      const raw = await client.rawGet(c.path, c.query);
      results.push({ path: c.path + (c.query ? `?${new URLSearchParams(Object.entries(c.query).map(([k, v]) => [k, String(v)])).toString()}` : ""), ok: true, sample: JSON.parse(JSON.stringify(raw).slice(0, 800)) });
    } catch (e) {
      results.push({ path: c.path, ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  }
  return NextResponse.json({ ok: true, rep, account: client.label, contactId, results });
}
