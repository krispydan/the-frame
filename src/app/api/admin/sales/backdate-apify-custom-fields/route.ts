export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { phoneBurnerClient } from "@/modules/sales/lib/phoneburner-client";

/**
 * POST /api/admin/sales/backdate-apify-custom-fields
 *
 * Retro-fills the Company ID / Company Name / Website / Domain custom
 * fields onto every PhoneBurner contact we already pushed via the
 * Apify endpoint. Those contacts were created without the custom
 * fields, so their call-result webhooks can only resolve by phone.
 * Adding "Company ID" makes them resolve via the strong path (and
 * matches the pre-created PB workspace fields).
 *
 * Walks phoneburner_folder_pushes rows that carry a pb_contact_id,
 * joins the company, and PUTs /contacts/{id} with the custom fields.
 *
 * Idempotent — PB updates the same field in place. Concurrency-limited
 * inside the client's rate limiter.
 *
 * Body (optional): { dryRun?: boolean, limit?: number }
 * Auth: x-admin-key: jaxy2026
 */
interface Row {
  pb_contact_id: string;
  company_id: string;
  name: string | null;
  website: string | null;
  domain: string | null;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { dryRun?: boolean; limit?: number } = {};
  try { body = await req.json(); } catch { /* empty OK */ }
  const dryRun = body.dryRun === true;
  const limit = Math.min(5000, Math.max(1, body.limit ?? 5000));

  const rows = sqlite
    .prepare(
      `SELECT pfp.pb_contact_id AS pb_contact_id,
              pfp.company_id     AS company_id,
              co.name            AS name,
              co.website         AS website,
              co.domain          AS domain
         FROM phoneburner_folder_pushes pfp
         JOIN companies co ON co.id = pfp.company_id
        WHERE pfp.pb_contact_id IS NOT NULL
          AND pfp.pb_contact_id != ''
        LIMIT ?`,
    )
    .all(limit) as Row[];

  const summary = {
    ok: true,
    dry_run: dryRun,
    scanned: rows.length,
    updated: 0,
    errors: [] as Array<{ pb_contact_id: string; reason: string }>,
  };

  if (dryRun) {
    return NextResponse.json({
      ...summary,
      sample: rows.slice(0, 10).map((r) => ({
        pb_contact_id: r.pb_contact_id,
        company_id: r.company_id,
        name: r.name,
      })),
    });
  }

  await runWithConcurrency(rows, 5, async (r) => {
    // PB stores the numeric contact id; our stamp sometimes carries a
    // trailing ".0" (float coercion). Strip it for the PUT path.
    const id = String(r.pb_contact_id).replace(/\.0$/, "");
    try {
      await phoneBurnerClient.updateContact(id, {
        user_id: r.company_id,
        custom_fields: [
          { name: "Company ID", type: "text", value: r.company_id },
          { name: "Company Name", type: "text", value: r.name ?? "" },
          { name: "Website", type: "url", value: r.website ?? "" },
          { name: "Domain", type: "text", value: r.domain ?? "" },
        ].filter((f) => f.value),
      });
      summary.updated++;
    } catch (e) {
      summary.errors.push({ pb_contact_id: id, reason: e instanceof Error ? e.message : String(e) });
    }
  });

  return NextResponse.json(summary);
}
