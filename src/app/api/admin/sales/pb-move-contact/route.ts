export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { phoneBurnerAccounts } from "@/modules/sales/lib/phoneburner-client";

function shapeOnly(v: unknown, depth = 0): unknown {
  if (depth > 3 || v == null) return typeof v;
  if (Array.isArray(v)) return v.length === 0 ? "array[0]" : [`array[${v.length}]`, shapeOnly(v[0], depth + 1)];
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v).slice(0, 20)) out[k] = shapeOnly(val, depth + 1);
    return out;
  }
  return typeof v;
}

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
  const body = (await req.json()) as {
    contact_id?: string;
    move_out?: boolean;
    move_to?: string;
    set_dnc?: boolean;
    add_tag?: string;
    hard_delete?: boolean;
    create_dup_move?: string; // move existing to this folder via createContact+on_duplicate
    email?: string; // needed for create_dup_move
  };
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
        // HATEOAS links from the raw response — PB often advertises
        // available operations here.
        _links: (raw as Record<string, unknown>)?._links ?? null,
      };
      if (body.hard_delete) {
        // Probe every plausible delete shape until nested category clears
        // or contact vanishes.
        type P = { label: string; method: string; path: string; body?: unknown };
        const shapes: P[] = [
          { label: "bulk_contact_ids", method: "DELETE", path: `/contacts`, body: { contact_ids: [contactId] } },
          { label: "bulk_ids", method: "DELETE", path: `/contacts`, body: { ids: [contactId] } },
          { label: "bulk_query", method: "DELETE", path: `/contacts?contact_id=${contactId}` },
          { label: "single_del", method: "DELETE", path: `/contacts/${contactId}` },
        ];
        const results: Array<Record<string, unknown>> = [];
        for (const s of shapes) {
          const r: Record<string, unknown> = { label: s.label, method: s.method, path: s.path };
          try {
            const resp = await (
              s.method === "DELETE" ? acct.client.rawDelete(s.path, s.body)
              : acct.client.rawGet(s.path)
            );
            r.resp = shapeOnly(resp);
          } catch (e) {
            r.error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
          }
          try {
            const g = await acct.client.getContact(contactId);
            // extract just the "removed" / "trashed" / "archived" state
            let rec = g as Record<string, unknown>;
            if (rec.contacts && typeof rec.contacts === "object") rec = rec.contacts as Record<string, unknown>;
            const inner = rec.contacts;
            if (Array.isArray(inner)) rec = (inner[0] as Record<string, unknown>) || {};
            r.after_state = {
              removed: rec?.removed ?? null,
              trashed: rec?.trashed ?? null,
              archived: rec?.archived ?? null,
              category_still_set: (rec?.category as { category_id?: unknown } | null)?.category_id ?? null,
            };
          } catch (e) {
            r.gone = true;
            r.after_get_error = (e instanceof Error ? e.message : String(e)).slice(0, 100);
          }
          results.push(r);
          if (r.gone) break;
        }
        attempt.after = results;
      } else if (body.create_dup_move && body.email) {
        // Try createContact for an EXISTING email but with a new category_id
        // + on_duplicate: "update". Hypothesis: this codepath actually moves
        // the contact into the new folder (unlike updateContact PUT).
        if (acct.rep !== "sandra") { attempt.after = { skipped: "sandra_only" }; }
        else {
          const cached = (await import("@/lib/db")).sqlite
            .prepare("SELECT value FROM settings WHERE key = 'phoneburner_owner_id' LIMIT 1")
            .get() as { value: string | null } | undefined;
          const ownerId = cached?.value || (await acct.client.discoverOwnerId()) || "";
          const r: Record<string, unknown> = { email: body.email, target_folder: body.create_dup_move };
          try {
            const resp = await acct.client.createContact({
              owner_id: ownerId,
              first_name: "MoveTest",
              last_name: "MoveTest",
              email: body.email,
              category_id: body.create_dup_move,
              on_duplicate: "update",
            });
            r.create_response = { id: resp.id };
          } catch (e) {
            r.create_error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
          }
          // Re-fetch to see current nested category
          try {
            const afterRaw = await acct.client.getContact(contactId);
            let ac = afterRaw as Record<string, unknown>;
            if (ac?.contacts && typeof ac.contacts === "object") ac = ac.contacts as Record<string, unknown>;
            const ai = ac.contacts;
            if (Array.isArray(ai)) ac = (ai[0] as Record<string, unknown>) || {};
            else if (ai && typeof ai === "object") ac = ai as Record<string, unknown>;
            const nested = (ac.category as { category_id?: unknown } | null | undefined)?.category_id ?? null;
            r.nested_category_after = nested;
            r.moved = String(nested) === body.create_dup_move;
          } catch { /* ignore */ }
          attempt.after = r;
        }
      } else if (body.set_dnc || body.add_tag) {
        // Just ONE mutation, ONE rep — to avoid rate-limit hangs.
        if (acct.rep !== "sandra") {
          attempt.after = { skipped: "sandra_only_probe" };
        } else {
          const payload: Record<string, unknown> = {};
          if (body.set_dnc) payload.do_not_call = 1;
          if (body.add_tag) payload.tags = [body.add_tag];
          const r: Record<string, unknown> = { payload };
          try {
            await acct.client.updateContact(contactId, payload as never);
          } catch (e) {
            r.error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
          }
          try {
            const afterRaw = await acct.client.getContact(contactId);
            let ac = afterRaw as Record<string, unknown>;
            if (ac?.contacts && typeof ac.contacts === "object") ac = ac.contacts as Record<string, unknown>;
            const ai = ac.contacts;
            if (Array.isArray(ai)) ac = (ai[0] as Record<string, unknown>) || {};
            else if (ai && typeof ai === "object") ac = ai as Record<string, unknown>;
            r.after_dnc = ac.do_not_call ?? null;
            r.after_tags = ac.tags ?? null;
          } catch { /* ignore */ }
          attempt.after = r;
        }
      } else if (body.move_to) {
        // Move to a real target folder — proven to work with updateContact.
        try {
          await acct.client.updateContact(contactId, { category_id: body.move_to } as never);
          const afterRaw = await acct.client.getContact(contactId);
          let ac = afterRaw as Record<string, unknown>;
          if (ac?.contacts && typeof ac.contacts === "object") ac = ac.contacts as Record<string, unknown>;
          const ai = ac.contacts;
          if (Array.isArray(ai)) ac = (ai[0] as Record<string, unknown>) || {};
          else if (ai && typeof ai === "object") ac = ai as Record<string, unknown>;
          const nestedCategory = (ac.category as { category_id?: unknown } | null | undefined)?.category_id ?? null;
          attempt.after = { move_to: body.move_to, nested_after: nestedCategory, success: String(nestedCategory) === body.move_to };
        } catch (e) {
          attempt.after = { move_to: body.move_to, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
        }
      } else if (body.move_out) {
        // Probe several endpoints/verbs — PUT /contacts/{id} with
        // any category shape didn't clear the nested category. Try
        // folder-scoped delete + category-scoped delete + POST actions.
        type Attempt = { label: string; method: string; path: string; body?: unknown };
        const attempts_shape: Attempt[] = [
          { label: "delete_folder_contact",   method: "DELETE", path: `/folders/66249536/contacts/${contactId}` },
          { label: "delete_contact_category", method: "DELETE", path: `/contacts/${contactId}/category` },
          { label: "delete_category_scope",   method: "DELETE", path: `/categories/66249536/contacts/${contactId}` },
          { label: "put_contact_category_null", method: "PUT", path: `/contacts/${contactId}/category`, body: {} },
          { label: "post_folder_remove", method: "POST", path: `/folders/66249536/contacts/remove`, body: { contact_ids: [contactId] } },
        ];
        const results: Array<Record<string, unknown>> = [];
        for (const a of attempts_shape) {
          const r: Record<string, unknown> = { label: a.label, method: a.method, path: a.path };
          try {
            const resp = await (
              a.method === "DELETE" ? acct.client.rawDelete(a.path, a.body)
              : a.method === "POST" ? acct.client.rawPost(a.path, a.body)
              : a.method === "PUT"  ? acct.client.rawPut(a.path, a.body)
              : acct.client.rawGet(a.path)
            );
            r.status_shape = shapeOnly(resp);
          } catch (e) {
            r.error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
          }
          // Re-check nested category
          try {
            const afterRaw = await acct.client.getContact(contactId);
            let ac = afterRaw as Record<string, unknown>;
            if (ac?.contacts && typeof ac.contacts === "object") ac = ac.contacts as Record<string, unknown>;
            const ai = ac.contacts;
            if (Array.isArray(ai)) ac = (ai[0] as Record<string, unknown>) || {};
            else if (ai && typeof ai === "object") ac = ai as Record<string, unknown>;
            const nestedCategory = (ac.category as { category_id?: unknown } | null | undefined)?.category_id ?? null;
            r.nested_after = nestedCategory;
            r.success = nestedCategory == null;
          } catch { /* ignore */ }
          results.push(r);
          if (r.success) break;
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
