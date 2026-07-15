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

  const candidates: Array<{ label: string; path: string; query?: Record<string, string | number> }> = [
    { label: "size_25", path: `/contacts`, query: { sort: "date_updated", order: "desc", page_size: 25, page: 1 } },
    { label: "size_50", path: `/contacts`, query: { sort: "date_updated", order: "desc", page_size: 50, page: 1 } },
    { label: "size_100", path: `/contacts`, query: { sort: "date_updated", order: "desc", page_size: 100, page: 1 } },
    { label: "size_200", path: `/contacts`, query: { sort: "date_updated", order: "desc", page_size: 200, page: 1 } },
  ];

  const results: Array<{ label: string; path: string; ok: boolean; keys?: string[]; count?: number; firstIds?: string[]; sample?: string; error?: string }> = [];
  for (const c of candidates) {
    const qs = c.query ? `?${new URLSearchParams(Object.entries(c.query).map(([k, v]) => [k, String(v)])).toString()}` : "";
    try {
      const raw = await client.rawGet(c.path, c.query);
      const str = JSON.stringify(raw);
      // Surface the first contact record's field names so we can see if
      // date_updated / primary_email / primary_phone are present.
      let keys: string[] | undefined;
      let count: number | undefined;
      let firstIds: string[] | undefined;
      try {
        const r = raw as Record<string, unknown>;
        const arr = (r?.contacts as { contacts?: unknown[] })?.contacts;
        if (Array.isArray(arr)) {
          count = arr.length;
          firstIds = arr.slice(0, 3).map((x) => String((x as Record<string, unknown>)?.user_id ?? "?"));
          const first = arr[0];
          if (first && typeof first === "object") keys = Object.keys(first as Record<string, unknown>);
        }
      } catch { /* ignore */ }
      results.push({ label: c.label, path: c.path + qs, ok: true, keys, count, firstIds, sample: str.slice(0, 200) });
    } catch (e) {
      results.push({ label: c.label, path: c.path + qs, ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  }
  return NextResponse.json({ ok: true, rep, account: client.label, contactId, results });
}
