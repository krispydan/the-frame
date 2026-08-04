export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { phoneBurnerAccounts } from "@/modules/sales/lib/phoneburner-client";

/**
 * POST /api/admin/sales/pb-tag-ignore-cohort
 *
 * Tag PhoneBurner contacts as ignore-cohort so Sandra & Christina can
 * filter their dial view. We discovered PB's API silently no-ops
 * category_id updates (can't remove from a folder) but DOES accept tag
 * updates via updateContact. This endpoint uses that path.
 *
 * Body:
 *   { tag: "AJM_IGNORE_v7",
 *     emails: ["a@b.com", ...],   // ignore-cohort emails from CSV
 *     dryRun?: true }
 *
 * Strategy: iterate every rep account, search-then-tag. Each rep's
 * search hits their own owner_id + workspace-visible contacts. We
 * find by email (rawGet with `search`) and updateContact({tags:[tag]})
 * via the rep client that can see it.
 *
 * Idempotent: PB tags are additive-by-title (same title = no dup).
 *
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
    console.error("[pb-tag-ignore-cohort] crashed:", e);
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
  const body = (await req.json()) as { tag?: string; emails?: string[]; dryRun?: boolean };
  const tag = String(body.tag || "").trim();
  const emails = (body.emails || []).map((e) => e.toLowerCase().trim()).filter(Boolean);
  if (!tag) return NextResponse.json({ ok: false, error: "tag required" }, { status: 400 });
  if (emails.length === 0) return NextResponse.json({ ok: false, error: "emails[] required" }, { status: 400 });

  const accounts = phoneBurnerAccounts();

  if (body.dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      tag,
      total_emails: emails.length,
      reps: accounts.map((a) => a.rep),
      sample: emails.slice(0, 10),
    });
  }

  let tagged = 0;
  let notFound = 0;
  const errors: Array<{ email: string; reason: string }> = [];

  await runWithConcurrency(emails, 6, async (email) => {
    // Find the contact via PB search on ANY rep account. First hit wins.
    let contactId = "";
    let ownerClient = accounts[0].client;
    for (const acct of accounts) {
      try {
        const raw = (await acct.client.rawGet("/contacts", { search: email, page_size: 5 })) as
          | Record<string, unknown>
          | null;
        if (!raw) continue;
        const env = ((raw.contacts ?? raw) as Record<string, unknown>) || {};
        const arr = (env.contacts as unknown[]) || [];
        for (const c of Array.isArray(arr) ? arr : []) {
          const rec = c as Record<string, unknown>;
          const pe = rec.primary_email as { email_address?: unknown } | string | undefined;
          const found = typeof pe === "string" ? pe.toLowerCase() : String((pe?.email_address as string) || "").toLowerCase();
          if (found === email) {
            contactId = String(rec.user_id || rec.id || "");
            ownerClient = acct.client;
            break;
          }
        }
        if (contactId) break;
      } catch (e) {
        errors.push({ email, reason: `search:${acct.rep}:${(e instanceof Error ? e.message : String(e)).slice(0, 100)}` });
      }
    }
    if (!contactId) {
      notFound++;
      return;
    }
    try {
      await ownerClient.updateContact(contactId, { tags: [tag] } as never);
      tagged++;
    } catch (e) {
      errors.push({ email, reason: `tag:${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` });
    }
  });

  return NextResponse.json({
    ok: true,
    tag,
    input: emails.length,
    tagged,
    not_found: notFound,
    error_count: errors.length,
    errors: errors.slice(0, 20),
  });
}
