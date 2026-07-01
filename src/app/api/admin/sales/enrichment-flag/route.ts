export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET  /api/admin/sales/enrichment-flag  → current state
 * POST /api/admin/sales/enrichment-flag  { enabled: boolean }
 *
 * Master switch for the interested-lead enrichment WRITE-backs (contact
 * name/email overwrite + Pipedrive person/note/activity/opener). The AI
 * analysis + Slack notification run regardless of this flag; only the
 * writes are gated. Setting key: interested_enrichment_enabled.
 *
 * Auth: x-admin-key: jaxy2026
 */
function get(): string {
  const row = sqlite
    .prepare("SELECT value FROM settings WHERE key = 'interested_enrichment_enabled' LIMIT 1")
    .get() as { value: string | null } | undefined;
  return row?.value ?? "(unset)";
}

export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, interested_enrichment_enabled: get() });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { enabled?: boolean } = {};
  try { body = await req.json(); } catch { /* empty */ }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "body { enabled: boolean } required" }, { status: 400 });
  }
  const value = body.enabled ? "true" : "false";
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, type, module, updated_at)
       VALUES ('interested_enrichment_enabled', ?, 'string', 'sales', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(value);
  return NextResponse.json({ ok: true, interested_enrichment_enabled: get() });
}
