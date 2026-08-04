export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { progressCompanyStatus } from "@/modules/sales/lib/status-progression";

/**
 * POST /api/admin/sales/promote-to-interested
 *
 * Manually promote companies to `interested` status. Used when a rep
 * hits "Set Appt" in PhoneBurner but the sync path (webhook or poller)
 * missed the event — happens on old AJM reactivation contacts where
 * the resolver couldn't find them, or when the PB call-list API is
 * silently returning 404 (which it currently is).
 *
 * status-progression auto-fans-out to Pipedrive so the deal appears
 * on the kanban.
 *
 * Body:
 *   { emails?: string[], names?: string[], dryRun?: boolean }
 *
 * Match order per input:
 *   1. contacts.email (exact case-insensitive)
 *   2. companies.name LIKE '%name%' (fuzzy — first match wins)
 *
 * Auth: x-admin-key: jaxy2026
 */

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json()) as { emails?: string[]; names?: string[]; dryRun?: boolean };
  const emails = (body.emails || []).map((e) => e.toLowerCase().trim()).filter(Boolean);
  const names = (body.names || []).map((n) => n.trim()).filter(Boolean);
  if (emails.length === 0 && names.length === 0) {
    return NextResponse.json({ ok: false, error: "emails[] or names[] required" }, { status: 400 });
  }

  const byEmailStmt = sqlite.prepare(
    `SELECT c.id, c.name, c.status FROM companies c
      JOIN contacts ct ON ct.company_id = c.id
      WHERE lower(ct.email) = ?
      LIMIT 1`,
  );
  const byNameStmt = sqlite.prepare(
    `SELECT id, name, status FROM companies WHERE upper(name) LIKE ? ORDER BY updated_at DESC LIMIT 1`,
  );

  interface Result {
    input: string;
    matched_by: "email" | "name" | null;
    company_id: string | null;
    company_name: string | null;
    status_before: string | null;
    status_after: string | null;
    error?: string;
  }
  const results: Result[] = [];

  const process = async (input: string, matchStmt: typeof byEmailStmt, matchBy: "email" | "name") => {
    const row = matchStmt.get(matchBy === "email" ? input : `%${input.toUpperCase()}%`) as
      | { id: string; name: string; status: string }
      | undefined;
    const r: Result = {
      input,
      matched_by: row ? matchBy : null,
      company_id: row?.id ?? null,
      company_name: row?.name ?? null,
      status_before: row?.status ?? null,
      status_after: row?.status ?? null,
    };
    if (!row) { results.push(r); return; }
    if (body.dryRun) { results.push(r); return; }
    try {
      const p = progressCompanyStatus(row.id, "interested", { source: "ui", force: true });
      r.status_after = p.to;
    } catch (e) {
      r.error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    }
    results.push(r);
  };

  for (const e of emails) await process(e, byEmailStmt, "email");
  for (const n of names) await process(n, byNameStmt, "name");

  return NextResponse.json({
    ok: true,
    dry_run: !!body.dryRun,
    matched: results.filter((r) => r.company_id != null).length,
    promoted: results.filter((r) => r.status_before !== "interested" && r.status_after === "interested").length,
    results,
  });
}
