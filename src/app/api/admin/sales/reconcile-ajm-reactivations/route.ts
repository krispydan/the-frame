export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { phoneBurnerClient } from "@/modules/sales/lib/phoneburner-client";

/**
 * POST /api/admin/sales/reconcile-ajm-reactivations
 *
 * Reconciles the AJM master (v6+) against Frame + a PhoneBurner folder so
 * Christina & Sandra only see callable leads.
 *
 * Body:
 * {
 *   folder_id: "66249536",              // PB folder to reconcile
 *   ignore:   [{email, company, ajm_ignore_reason, ...}, ...],
 *   callable: [{email, company, phone, first_name, last_name, ...}, ...],
 *   dryRun?:  true                       // preview only, no mutations
 * }
 *
 * Ignore = Status='Closed Lost' OR Ignore Reason != '' (12k+ rows).
 *   → Frame: companies.status='not_qualified' + companies.ajm_ignore_reason.
 *     (never touches rows already status='customer' — those are real
 *     Jaxy buyers who should not be demoted.)
 *   → PB: any contact in `folder_id` whose email matches gets moved out
 *     of the folder (category_id set to null via updateContact). We
 *     don't delete — that would lose historical call notes.
 *
 * Callable = no Status, no Ignore Reason, has email (~1k rows).
 *   → PB: createOrGetContact into `folder_id`, on_duplicate:"update"
 *     so pre-existing contacts get moved INTO the folder.
 *   → Frame: no status change (leave whatever pipeline stage they're at).
 *
 * Idempotent — safe to re-run on the same payload.
 * Auth: x-admin-key: jaxy2026.
 */

interface Row {
  email: string;
  company?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
  city?: string;
  state?: string;
  total_orders?: string;
  total_spend?: string;
  first_order?: string;
  last_order?: string;
  category?: string;
  ajm_ignore_reason?: string;
  reason?: string;
  status?: string;
}

interface Body {
  folder_id?: string;
  ignore?: Row[];
  callable?: Row[];
  dryRun?: boolean;
}

interface PbContactSummary {
  id: string;
  email: string;
  category_id: string | null;
}

/**
 * Return the shape of a nested JSON value: keys + types, no values.
 * Used to surface the actual PB API response shape when parsing returns 0
 * contacts, so we can adjust the parser without needing token access.
 */
/**
 * Simple concurrency-limited task runner. Kicks off `limit` workers that
 * pull from the shared queue until it's empty. Avoids Cloudflare's 100s
 * edge cap on long serial API loops.
 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await task(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

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

export async function POST(req: NextRequest) {
  try {
    return await handle(req);
  } catch (e) {
    console.error("[reconcile-ajm-reactivations] crashed:", e);
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack?.split("\n").slice(0, 8) : undefined,
      },
      { status: 500 },
    );
  }
}

async function handle(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json()) as Body;
  const folderId = String(body.folder_id || "").trim();
  const ignore = (body.ignore || []).filter((r) => r.email);
  const callable = (body.callable || []).filter((r) => r.email);
  if (!folderId) return NextResponse.json({ ok: false, error: "folder_id required" }, { status: 400 });
  if (ignore.length === 0 && callable.length === 0) {
    return NextResponse.json({ ok: false, error: "empty ignore + callable" }, { status: 400 });
  }

  // Normalise emails lowercase for match sets
  const ignoreByEmail = new Map<string, Row>();
  for (const r of ignore) ignoreByEmail.set(r.email.toLowerCase(), r);
  const callableByEmail = new Map<string, Row>();
  for (const r of callable) callableByEmail.set(r.email.toLowerCase(), r);

  // ── 1. Frame: flip ignore-set companies to not_qualified ──────────────
  const frameUpdate = sqlite.prepare(
    `UPDATE companies
        SET status = 'not_qualified',
            ajm_ignore_reason = ?,
            updated_at = datetime('now')
      WHERE id = (SELECT company_id FROM contacts WHERE lower(email) = ? LIMIT 1)
        AND status != 'customer'`,
  );
  let frameUpdated = 0;
  const frameSkippedCustomers: string[] = [];
  const customerCheck = sqlite.prepare(
    `SELECT c.id, c.status FROM companies c
       JOIN contacts ct ON ct.company_id = c.id
      WHERE lower(ct.email) = ? LIMIT 1`,
  );

  if (!body.dryRun) {
    for (const r of ignore) {
      const email = r.email.toLowerCase();
      const co = customerCheck.get(email) as { id: string; status: string } | undefined;
      if (!co) continue;
      if (co.status === "customer") {
        frameSkippedCustomers.push(r.email);
        continue;
      }
      frameUpdate.run(r.ajm_ignore_reason || r.reason || "closed_lost", email);
      frameUpdated++;
    }
  }

  // ── 2. PhoneBurner: enumerate current folder contents ────────────────
  // PB API shape (per listContactsByUpdated at phoneburner-client.ts:305):
  //   { contacts: { contacts: [...], total_pages: N } }
  // Each contact has `user_id` (id) + `primary_email.email_address` +
  // `category_id`.
  const folderContacts: PbContactSummary[] = [];
  let page = 1;
  let pageCap = 500; // safety
  let totalPages: number | null = null;
  let rawShapeSample: unknown = null;
  while (pageCap-- > 0) {
    const raw = (await phoneBurnerClient.rawGet("/contacts", {
      category_id: folderId,
      page,
      page_size: 100,
    })) as Record<string, unknown> | null;
    if (!raw) break;
    if (page === 1) rawShapeSample = shapeOnly(raw);
    const env = ((raw.contacts ?? raw) as Record<string, unknown>) || {};
    const arr = (env.contacts as unknown[]) || [];
    const list: unknown[] = Array.isArray(arr) ? arr : [];
    if (totalPages == null) {
      const tp = env.total_pages ?? env.totalPages;
      totalPages = tp != null && Number.isFinite(Number(tp)) ? Number(tp) : null;
    }
    if (list.length === 0) break;
    for (const c of list) {
      const rec = c as Record<string, unknown>;
      const id = String(rec.user_id || rec.id || "");
      // Primary email: { email_address: "..." } or a raw string.
      const pe = rec.primary_email as { email_address?: unknown } | string | undefined;
      const primaryEmail = typeof pe === "string"
        ? pe.toLowerCase().trim()
        : String((pe?.email_address as string) || "").toLowerCase().trim();
      const catId = rec.category_id != null ? String(rec.category_id) : null;
      if (id && primaryEmail) folderContacts.push({ id, email: primaryEmail, category_id: catId });
    }
    if (totalPages != null && page >= totalPages) break;
    if (list.length < 100) break;
    page++;
  }

  // ── 3. PB: move ignore-matches OUT of the folder ─────────────────────
  const pbToMoveOut: PbContactSummary[] = folderContacts.filter((c) =>
    ignoreByEmail.has(c.email),
  );
  let pbMovedOut = 0;
  const pbMoveErrors: Array<{ id: string; email: string; reason: string }> = [];

  if (!body.dryRun) {
    // Parallelize with concurrency 8 to stay under Cloudflare's 100s edge cap.
    await runWithConcurrency(pbToMoveOut, 8, async (c) => {
      try {
        // Clear category — contact stays in PB (history preserved) but leaves this folder.
        await phoneBurnerClient.updateContact(c.id, { category_id: undefined });
        pbMovedOut++;
      } catch (e) {
        pbMoveErrors.push({ id: c.id, email: c.email, reason: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  // ── 4. PB: add callable that aren't already in the folder ────────────
  const folderEmailSet = new Set(folderContacts.map((c) => c.email));
  const pbToAdd = callable.filter((r) => !folderEmailSet.has(r.email.toLowerCase()));
  let pbAdded = 0;
  const pbAddErrors: Array<{ email: string; reason: string }> = [];

  let ownerId = "";
  if (!body.dryRun && pbToAdd.length > 0) {
    const cached = sqlite
      .prepare("SELECT value FROM settings WHERE key = 'phoneburner_owner_id' LIMIT 1")
      .get() as { value: string | null } | undefined;
    ownerId = cached?.value || (await phoneBurnerClient.discoverOwnerId()) || "";
    if (!ownerId) {
      return NextResponse.json(
        { ok: false, error: "PhoneBurner owner_id unavailable" },
        { status: 502 },
      );
    }

    await runWithConcurrency(pbToAdd, 8, async (r) => {
      try {
        const noteLines: string[] = [
          `AJM reactivation: ${r.company || ""}${r.city ? ` — ${r.city}, ${r.state || ""}` : ""}`,
        ];
        if (r.total_orders) noteLines.push(`${r.total_orders} orders / ${r.total_spend || "-"} lifetime`);
        if (r.first_order || r.last_order) noteLines.push(`first ${r.first_order || "-"} last ${r.last_order || "-"}`);
        if (r.category) noteLines.push(`AJM cat: ${r.category}`);

        const { id } = await phoneBurnerClient.createOrGetContact({
          owner_id: ownerId,
          first_name: (r.first_name || r.company || "").slice(0, 64) || "-",
          last_name: r.last_name || r.company?.slice(0, 40) || "-",
          email: r.email,
          phone: r.phone || undefined,
          category_id: folderId,
          notes: noteLines.join("\n"),
          on_duplicate: "update",
        });
        if (!id) throw new Error("createOrGetContact returned no id");
        pbAdded++;
      } catch (e) {
        pbAddErrors.push({ email: r.email, reason: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  return NextResponse.json({
    ok: true,
    dry_run: !!body.dryRun,
    folder_id: folderId,
    input: { ignore_count: ignore.length, callable_count: callable.length },
    frame: {
      updated_to_not_qualified: frameUpdated,
      skipped_because_customer: frameSkippedCustomers.length,
      customer_emails_skipped: frameSkippedCustomers.slice(0, 20),
    },
    phoneburner: {
      folder_current_size: folderContacts.length,
      total_pages: totalPages,
      raw_shape_page1: rawShapeSample,
      to_move_out: pbToMoveOut.length,
      moved_out: pbMovedOut,
      move_errors: pbMoveErrors.slice(0, 20),
      to_add: pbToAdd.length,
      added: pbAdded,
      add_errors: pbAddErrors.slice(0, 20),
    },
  });
}
