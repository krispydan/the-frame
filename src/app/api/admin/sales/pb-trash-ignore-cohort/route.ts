export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { phoneBurnerAccounts } from "@/modules/sales/lib/phoneburner-client";

/**
 * POST /api/admin/sales/pb-trash-ignore-cohort
 *
 * Bulk-trash PhoneBurner contacts. Confirmed empirically: DELETE
 * /contacts/{id} sets `trashed=1` on the contact regardless of which
 * rep account calls it. Once trashed, PB should exclude the contact
 * from dial queues (Sandra/Christina no longer see them).
 *
 * Search + trash workflow: for each email in the input, search PB via
 * every rep account, collect matched contact_ids (deduped across reps),
 * then DELETE each via the OWNER's rep client. Idempotent — trashing
 * a trashed contact is a no-op.
 *
 * Body: { emails: string[], dryRun?: boolean }
 * Auth: x-admin-key: jaxy2026
 */

async function runWithConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await task(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function POST(req: NextRequest) {
  try {
    return await handle(req);
  } catch (e) {
    console.error("[pb-trash-ignore-cohort] crashed:", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

async function handle(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json()) as { emails?: string[]; folder_id?: string; dryRun?: boolean };
  const emails = (body.emails || []).map((e) => e.toLowerCase().trim()).filter(Boolean);
  if (emails.length === 0) return NextResponse.json({ ok: false, error: "emails[] required" }, { status: 400 });
  const folderFilter = body.folder_id ? String(body.folder_id) : null;

  const accounts = phoneBurnerAccounts();
  const wanted = new Set(emails);

  // Enumerate ALL PB contacts across all rep accounts, building an
  // email → contact map. PB's /contacts search-param is a no-op (it
  // returns the whole workspace regardless of what you pass), so a
  // single enumeration is way faster than 1 search per email.
  interface Hit { email: string; contact_id: string; owner_id: string; already_trashed: boolean }
  const emailToHit = new Map<string, Hit>();

  for (const acct of accounts) {
    let page = 1;
    let pageCap = 200;
    while (pageCap-- > 0) {
      let raw: Record<string, unknown> | null;
      try {
        // Note: PB's /contacts search-param is a no-op but category_id
        // filter DOES work (returns only that folder's owner-visible
        // contacts). Use it when narrowing.
        raw = (await acct.client.rawGet("/contacts", folderFilter
          ? { category_id: folderFilter, page, page_size: 100 }
          : { page, page_size: 100 }
        )) as Record<string, unknown> | null;
      } catch {
        break;
      }
      if (!raw) break;
      const env = ((raw.contacts ?? raw) as Record<string, unknown>) || {};
      const arr = (env.contacts as unknown[]) || [];
      const list: unknown[] = Array.isArray(arr) ? arr : [];
      if (list.length === 0) break;
      for (const c of list) {
        const rec = c as Record<string, unknown>;
        const pe = rec.primary_email as { email_address?: unknown } | string | undefined;
        const cEmail = typeof pe === "string"
          ? pe.toLowerCase().trim()
          : String((pe?.email_address as string) || "").toLowerCase().trim();
        if (!cEmail || !wanted.has(cEmail)) continue;
        // First-hit wins per email (prevents dup work across rep enumerations)
        if (emailToHit.has(cEmail)) continue;
        emailToHit.set(cEmail, {
          email: cEmail,
          contact_id: String(rec.user_id || rec.id || ""),
          owner_id: String(rec.owner_id || ""),
          already_trashed: String(rec.trashed || "") === "1",
        });
      }
      if (list.length < 100) break;
      page++;
    }
  }

  const hits: Hit[] = Array.from(emailToHit.values());
  const notFound = emails.filter((e) => !emailToHit.has(e));

  if (body.dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      input: emails.length,
      hits_found: hits.length,
      already_trashed: hits.filter((h) => h.already_trashed).length,
      not_found: notFound.length,
      sample_hits: hits.slice(0, 10),
      sample_not_found: notFound.slice(0, 10),
    });
  }

  // Trash each unique contact — use the account whose owner_id matches,
  // fall back to sandra (proven to trash cross-owner contacts anyway).
  const toTrash = hits.filter((h) => !h.already_trashed);
  let trashed = 0;
  const errors: Array<{ contact_id: string; email: string; reason: string }> = [];
  const sandra = accounts.find((a) => a.rep === "sandra")!;

  await runWithConcurrency(toTrash, 6, async (h) => {
    const client = accounts.find((a) => {
      // We don't have direct owner-user-id → rep mapping in this scope, so
      // use sandra by default (verified to work in probes).
      return a.rep === "sandra";
    })?.client ?? sandra.client;
    try {
      await client.rawDelete(`/contacts/${h.contact_id}`);
      trashed++;
    } catch (e) {
      errors.push({ contact_id: h.contact_id, email: h.email, reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    }
  });

  return NextResponse.json({
    ok: true,
    input: emails.length,
    hits_found: hits.length,
    not_found: notFound.length,
    already_trashed: hits.filter((h) => h.already_trashed).length,
    newly_trashed: trashed,
    error_count: errors.length,
    errors: errors.slice(0, 20),
  });
}
