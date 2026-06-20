export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { importAjmRows, AjmRow, AjmImportSummary } from "@/modules/sales/lib/ajm-import";

/**
 * POST /api/admin/sales/import-ajm
 *
 * Body: multipart/form-data
 *   file       — ajm_import.jsonl (required, one JSON row per line)
 *   key        — admin key (jaxy2026)
 *   dryRun     — "true" to compute counts without writing
 *
 * Or: application/json
 *   { key, dryRun?, rows: AjmRow[] }
 *
 * Idempotent. Dedupe cascade: email → domain → name+state → phone.
 * Matched rows get tag-merged (no clobber); new rows get created with
 * AJM cohort tags + status (customer for real Jaxy matches, qualified_lead
 * for winback). Phones flow into company_phones via the legacy
 * `companies.phone` mirror trigger from db.ts.
 *
 * Returns the full {@link AjmImportSummary}.
 */
export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  let rows: AjmRow[] | null = null;
  let dryRun = false;
  let key = "";

  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const fd = await req.formData();
    key = (fd.get("key") as string | null) ?? "";
    dryRun = (fd.get("dryRun") as string | null) === "true";
    const file = fd.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ ok: false, error: "file required" }, { status: 400 });
    }
    const text = await file.text();
    rows = parseJsonl(text);
  } else {
    let body: { key?: string; dryRun?: boolean; rows?: AjmRow[] } = {};
    try { body = await req.json(); } catch {
      return NextResponse.json({ ok: false, error: "JSON body required" }, { status: 400 });
    }
    key = body.key ?? "";
    dryRun = !!body.dryRun;
    rows = body.rows ?? null;
  }

  // Allow ?key=... fallback for curl convenience.
  if (!key) key = url.searchParams.get("key") ?? "";

  if (key !== "jaxy2026") {
    return NextResponse.json({ ok: false, error: "invalid admin key" }, { status: 401 });
  }
  if (!rows || rows.length === 0) {
    return NextResponse.json({ ok: false, error: "no rows in payload" }, { status: 400 });
  }

  let summary: AjmImportSummary;
  try {
    summary = importAjmRows(rows, { dryRun });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    summary,
  });
}

function parseJsonl(text: string): AjmRow[] {
  const out: AjmRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as AjmRow);
    } catch {
      // skip malformed lines; the caller will see the imported count vs
      // their file row count and notice the drift if needed.
    }
  }
  return out;
}
