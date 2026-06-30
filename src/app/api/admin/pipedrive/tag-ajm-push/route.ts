export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { tagAjmPushRows } from "@/modules/sales/lib/ajm-import";

/**
 * POST /api/admin/pipedrive/tag-ajm-push   (key-gated: x-admin-key: jaxy2026)
 *
 * Tag the curated wholesale subset (Sheet7) with `ajm_pipedrive_push` so the
 * AJM seed can find them. Matches rows to existing frame companies with the
 * same dedupe matcher the AJM import used (email → domain → name+state →
 * phone). Idempotent.
 *
 * Dry-run by default — append ?commit=1 to actually write the tags.
 *
 * Body: { rows: Array<{ name?, email?, phone?, state? }>, tag? }
 *   curl -XPOST '.../tag-ajm-push' -H 'x-admin-key: jaxy2026' \
 *        -H 'content-type: application/json' --data-binary @payload.json     # dry run
 *   curl -XPOST '.../tag-ajm-push?commit=1' ... --data-binary @payload.json  # write
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    rows?: Array<{ name?: string | null; email?: string | null; phone?: string | null; state?: string | null }>;
    tag?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return NextResponse.json({ error: "rows[] required" }, { status: 400 });
  }

  const commit = req.nextUrl.searchParams.get("commit") === "1";
  try {
    const summary = tagAjmPushRows(body.rows, body.tag || "ajm_pipedrive_push", { dryRun: !commit });
    return NextResponse.json({ ok: true, committed: commit, ...summary });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
