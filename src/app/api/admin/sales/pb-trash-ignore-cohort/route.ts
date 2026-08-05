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
  const body = (await req.json()) as { emails?: string[]; dryRun?: boolean };
  const emails = (body.emails || []).map((e) => e.toLowerCase().trim()).filter(Boolean);
  if (emails.length === 0) return NextResponse.json({ ok: false, error: "emails[] required" }, { status: 400 });

  const accounts = phoneBurnerAccounts();

  interface Hit { email: string; contact_id: string; owner_id: string; owning_rep: string | null; already_trashed: boolean }
  const hits: Hit[] = [];
  const notFound: string[] = [];

  await runWithConcurrency(emails, 6, async (email) => {
    // Try each rep to find the contact — PB search is per-authenticated-user
    // but usually returns visible-to-workspace results.
    let found: Hit | null = null;
    for (const acct of accounts) {
      try {
        const raw = (await acct.client.rawGet("/contacts", { search: email, page_size: 5 })) as
          | Record<string, unknown> | null;
        if (!raw) continue;
        const env = ((raw.contacts ?? raw) as Record<string, unknown>) || {};
        const arr = (env.contacts as unknown[]) || [];
        for (const c of Array.isArray(arr) ? arr : []) {
          const rec = c as Record<string, unknown>;
          const pe = rec.primary_email as { email_address?: unknown } | string | undefined;
          const cEmail = typeof pe === "string" ? pe.toLowerCase() : String((pe?.email_address as string) || "").toLowerCase();
          if (cEmail !== email) continue;
          const cid = String(rec.user_id || rec.id || "");
          const owner = String(rec.owner_id || "");
          const trashed = String(rec.trashed || "") === "1";
          // Prefer the rep whose owner_id matches. Fallback to any hit.
          const owningRep = accounts.find((a) => a.rep && rec.owner_id != null
            && String((rec.owner_id as string | number)) === (a.ownerSetting ? String((rec.owner_id as string | number)) : ""))?.rep ?? null;
          found = { email, contact_id: cid, owner_id: owner, owning_rep: owningRep, already_trashed: trashed };
          break;
        }
        if (found) break;
      } catch {
        // silent — try next rep
      }
    }
    if (found) hits.push(found);
    else notFound.push(email);
  });

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
