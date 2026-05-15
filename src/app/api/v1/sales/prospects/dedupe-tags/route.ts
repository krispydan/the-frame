export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { dedupeAllProspectTags } from "@/modules/sales/lib/dedupe-tags";

/**
 * POST /api/v1/sales/prospects/dedupe-tags
 *
 * One-shot cleanup that dedupes the `tags` JSON array on every prospect
 * row. Case-insensitive ("Vintage" == "vintage"), preserves the first
 * occurrence's casing + order. Re-running is a no-op once a row is
 * deduped.
 *
 * Body (optional):
 *   { "dryRun": true }   // preview without writing
 *
 * Response: { ok, scanned, modified, totalRemoved, changes[], malformed[] }
 *   - changes[] capped at 200 rows for response size sanity; full result
 *     is in the modified/totalRemoved totals.
 */
export async function POST(req: NextRequest) {
  let body: { dryRun?: boolean } = {};
  try {
    body = (await req.json()) as { dryRun?: boolean };
  } catch {
    // empty body fine
  }

  const result = dedupeAllProspectTags({ dryRun: !!body.dryRun });
  return NextResponse.json({
    ok: true,
    dryRun: !!body.dryRun,
    scanned: result.scanned,
    modified: result.modified,
    totalRemoved: result.totalRemoved,
    malformed: result.malformed,
    // Cap the per-row payload — operationally we just need totals plus a
    // sample to spot-check. Largest cleanup runs would otherwise blow up
    // the JSON response size.
    changes: result.changes.slice(0, 200),
    changesTruncated: result.changes.length > 200,
  });
}
