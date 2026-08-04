export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { phoneBurnerAccounts } from "@/modules/sales/lib/phoneburner-client";

/**
 * POST /api/admin/sales/verify-leads
 *
 * Diagnostic: for each email or company-name substring, report the
 * current Frame state + PhoneBurner presence across every configured
 * rep account. Used to sanity-check after a reconcile.
 *
 * Body:
 *   { emails?: string[], names?: string[], folder_id?: string }
 *
 * Returns per-input record:
 *   {
 *     input, matched_frame_companies: [...], matched_pb_contacts: [...]
 *   }
 *
 * Auth: x-admin-key: jaxy2026
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json()) as {
    emails?: string[];
    names?: string[];
    folder_id?: string;
  };
  const emails = (body.emails || []).map((e) => e.toLowerCase().trim()).filter(Boolean);
  const names = (body.names || []).map((n) => n.trim()).filter(Boolean);
  const folderFilter = body.folder_id ? String(body.folder_id) : null;

  const frameEmailStmt = sqlite.prepare(
    `SELECT c.id, c.name, c.status, c.ajm_ignore_reason, c.ajm_status,
            (SELECT ct.email FROM contacts ct WHERE ct.company_id = c.id AND lower(ct.email) = ? LIMIT 1) AS matched_email
       FROM companies c
       JOIN contacts ct ON ct.company_id = c.id
      WHERE lower(ct.email) = ?
      GROUP BY c.id
      LIMIT 5`,
  );
  const frameNameStmt = sqlite.prepare(
    `SELECT id, name, status, ajm_ignore_reason, ajm_status,
            (SELECT email FROM contacts WHERE company_id = companies.id AND email IS NOT NULL LIMIT 1) AS primary_email
       FROM companies
      WHERE upper(name) LIKE ?
      ORDER BY name
      LIMIT 10`,
  );

  const accounts = phoneBurnerAccounts();

  async function findInPb(email: string, name: string | null) {
    const hits: Array<{
      rep: string;
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      category_id: string | null;
    }> = [];
    for (const acct of accounts) {
      // PB /contacts supports free-text search via `search` param.
      const q = email || name || "";
      if (!q) continue;
      try {
        const raw = (await acct.client.rawGet("/contacts", {
          search: q,
          page_size: 25,
        })) as Record<string, unknown> | null;
        if (!raw) continue;
        const env = ((raw.contacts ?? raw) as Record<string, unknown>) || {};
        const arr = (env.contacts as unknown[]) || [];
        for (const c of Array.isArray(arr) ? arr : []) {
          const rec = c as Record<string, unknown>;
          const pe = rec.primary_email as { email_address?: unknown } | string | undefined;
          const contactEmail = typeof pe === "string"
            ? pe.toLowerCase().trim()
            : String((pe?.email_address as string) || "").toLowerCase().trim();
          const contactName = `${String(rec.first_name || "")} ${String(rec.last_name || "")}`.trim().toLowerCase();
          const emailMatch = email && contactEmail === email;
          const nameMatch = name && contactName.includes(name.toLowerCase());
          if (emailMatch || nameMatch) {
            hits.push({
              rep: acct.rep,
              id: String(rec.user_id || rec.id || ""),
              first_name: (rec.first_name as string) || null,
              last_name: (rec.last_name as string) || null,
              email: contactEmail || null,
              category_id: rec.category_id != null ? String(rec.category_id) : null,
            });
          }
        }
      } catch (e) {
        hits.push({
          rep: acct.rep,
          id: "error",
          first_name: null,
          last_name: null,
          email: null,
          category_id: (e instanceof Error ? e.message : String(e)).slice(0, 100),
        });
      }
    }
    return hits;
  }

  const results: unknown[] = [];
  for (const email of emails) {
    const frame = frameEmailStmt.all(email, email);
    const pb = await findInPb(email, null);
    results.push({
      input: { email },
      frame_matches: frame,
      pb_matches: pb,
      pb_in_target_folder: folderFilter
        ? pb.filter((h) => h.category_id === folderFilter)
        : undefined,
    });
  }
  for (const name of names) {
    const frame = frameNameStmt.all(`%${name.toUpperCase()}%`);
    const pb = await findInPb("", name);
    results.push({
      input: { name },
      frame_matches: frame,
      pb_matches: pb,
      pb_in_target_folder: folderFilter
        ? pb.filter((h) => h.category_id === folderFilter)
        : undefined,
    });
  }

  return NextResponse.json({
    ok: true,
    folder_id_filter: folderFilter,
    reps_checked: accounts.map((a) => a.rep),
    results,
  });
}
