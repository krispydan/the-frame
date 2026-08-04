export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { phoneBurnerAccounts } from "@/modules/sales/lib/phoneburner-client";

/**
 * POST /api/admin/sales/pb-move-contact
 *
 * Direct handle for a single PhoneBurner contact. Given an id, walk
 * every configured rep account, find which one owns the contact,
 * report its current state, and (if requested) clear its category_id
 * so it drops out of whatever folder it's in.
 *
 * Used when a reconcile misses a specific lead because the folder
 * listing didn't return it (PB's /contacts?category_id filter has
 * apparent gaps — we've observed ~500-vs-358 count mismatches).
 *
 * Body:
 *   { contact_id: "1296839589", move_out?: true }
 *
 * Auth: x-admin-key: jaxy2026
 */

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json()) as { contact_id?: string; move_out?: boolean };
  const contactId = String(body.contact_id || "").trim();
  if (!contactId) return NextResponse.json({ ok: false, error: "contact_id required" }, { status: 400 });

  const accounts = phoneBurnerAccounts();
  const attempts: Array<{
    rep: string;
    found: boolean;
    error?: string;
    before?: unknown;
    after?: unknown;
  }> = [];

  for (const acct of accounts) {
    const attempt: (typeof attempts)[number] = { rep: acct.rep, found: false };
    try {
      const raw = await acct.client.getContact(contactId);
      attempt.found = true;
      // PB returns single-contact requests as a full LIST envelope:
      //   { _link, _links, http_status, status,
      //     contacts: { contacts: [ {actual} ], total_results, page, ... } }
      // Peel to the first array element.
      let rec = raw as Record<string, unknown>;
      if (rec?.contacts && typeof rec.contacts === "object") rec = rec.contacts as Record<string, unknown>;
      // Inner "contacts" is the array of results — grab the first (only) one.
      const inner = rec.contacts;
      if (Array.isArray(inner)) {
        rec = (inner[0] as Record<string, unknown>) || {};
      } else if (inner && typeof inner === "object") {
        rec = inner as Record<string, unknown>;
      }
      const pe = rec.primary_email as { email_address?: unknown } | string | undefined;
      const email = typeof pe === "string" ? pe : (pe?.email_address as string) || null;
      attempt.before = {
        user_id: rec.user_id ?? rec.id ?? null,
        first_name: rec.first_name ?? null,
        last_name: rec.last_name ?? null,
        email,
        category_id: rec.category_id ?? null,
        category: rec.category ?? null,
        entities: rec.entities ?? null,
        tags: rec.tags ?? null,
        owner_id: rec.owner_id ?? null,
        contact_owner_id: rec.contact_owner_id ?? null,
        contact_user_id: rec.contact_user_id ?? null,
        do_not_call: rec.do_not_call ?? null,
        archived: rec.archived ?? null,
        trashed: rec.trashed ?? null,
        removed: rec.removed ?? null,
      };
      if (body.move_out) {
        // Try several mutation payloads — PB's remove-from-folder shape
        // isn't documented in what we have. Each attempt is followed by
        // a fresh getContact to check whether nested category cleared.
        const attempts_shape: Array<[string, Record<string, unknown>]> = [
          ["category_null", { category: null }],
          ["category_id_zero", { category_id: 0 }],
          ["category_id_empty", { category_id: "" }],
          ["category_id_null_str", { category_id: null }],
        ];
        const results: Array<Record<string, unknown>> = [];
        for (const [label, payload] of attempts_shape) {
          try {
            await acct.client.updateContact(contactId, payload as never);
          } catch (e) {
            results.push({ label, error: (e instanceof Error ? e.message : String(e)).slice(0, 120) });
            continue;
          }
          // Re-fetch to see if nested category cleared.
          const afterRaw = await acct.client.getContact(contactId);
          let ac = afterRaw as Record<string, unknown>;
          if (ac?.contacts && typeof ac.contacts === "object") ac = ac.contacts as Record<string, unknown>;
          const ai = ac.contacts;
          if (Array.isArray(ai)) ac = (ai[0] as Record<string, unknown>) || {};
          else if (ai && typeof ai === "object") ac = ai as Record<string, unknown>;
          const nestedCategory = (ac.category as { category_id?: unknown } | null | undefined)?.category_id ?? null;
          results.push({
            label,
            payload,
            nested_category_id_after: nestedCategory,
            top_category_id_after: ac.category_id ?? null,
            success: nestedCategory == null,
          });
          if (nestedCategory == null) break; // first success stops
        }
        attempt.after = results;
      }
    } catch (e) {
      attempt.error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    }
    attempts.push(attempt);
  }

  return NextResponse.json({
    ok: true,
    contact_id: contactId,
    reps_tried: accounts.map((a) => a.rep),
    attempts,
  });
}
