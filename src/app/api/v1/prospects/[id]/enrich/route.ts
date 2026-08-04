export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { enrichViaGoogleMaps } from "@/modules/sales/lib/google-maps-enrichment";
import { captureOneListing } from "@/modules/sales/lib/gmaps-profile";

/**
 * Enrich one prospect from Apify's Google Maps scraper.
 *
 * This used to call Outscraper. Apify is what the rest of the system already
 * runs on — the nightly cohort enrichment, the AJM sweep, the customer
 * profiling capture — so a manual click now goes down the same path and gets
 * the same matcher, the same AI second opinion on borderline names, and the
 * same permanently-closed and out-of-ICP handling. One provider, one
 * behaviour, one place to fix a bad match.
 *
 * Two writes happen per click: the pipeline fills the company's own columns
 * (phone, hours, rating, website…), and captureOneListing stores the full
 * listing so the Google Maps panel on this page and the aggregate Store DNA
 * profile both see it.
 */

/** Columns the Apify pipeline can fill — diffed before/after to report what changed. */
const TRACKED = [
  "name", "google_place_id", "google_rating", "google_review_count",
  "address", "zip", "country", "website", "gmaps_url", "gmaps_subtypes",
  "gmaps_description", "business_hours", "status", "disqualify_reason",
] as const;

function snapshot(id: string) {
  const row = sqlite
    .prepare(`SELECT ${TRACKED.join(", ")} FROM companies WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  const phones = (sqlite
    .prepare("SELECT COUNT(*) n FROM company_phones WHERE company_id = ?")
    .get(id) as { n: number }).n;
  return { row, phones };
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing prospect ID" }, { status: 400 });

  const before = snapshot(id);
  if (!before.row) {
    return NextResponse.json({ error: "Company not found", newFields: [] }, { status: 404 });
  }

  let result;
  try {
    // force: a manual click means "go and look now", not "skip because an
    // earlier sweep already tried and gave up".
    result = await enrichViaGoogleMaps({ limit: 1, companyId: id, force: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e), newFields: [] },
      { status: 500 },
    );
  }

  // Keep the listing table in step so both views reflect the click. This
  // failing doesn't undo the enrichment above, so it mustn't fail the request.
  await captureOneListing(id, { force: true }).catch(() => null);

  const after = snapshot(id);
  const newFields: string[] = [];
  for (const col of TRACKED) {
    if (before.row?.[col] !== after.row?.[col] && after.row?.[col] != null) newFields.push(col);
  }
  if (after.phones > before.phones) newFields.push("phone");

  // Distinguish the failure modes — "no such place" and "found one but it
  // isn't you" need different fixes, and the second is usually a bad
  // name/city on our side rather than anything Google did.
  if (result.no_match > 0) {
    return NextResponse.json(
      { error: "Google Maps returned no match for this business", newFields: [] },
      { status: 404 },
    );
  }
  if (result.low_confidence_skipped > 0) {
    return NextResponse.json(
      {
        error: "Found a place, but it didn't confidently match — check the name, city and state",
        newFields: [],
      },
      { status: 409 },
    );
  }
  if (result.errors.length > 0) {
    return NextResponse.json({ error: result.errors[0].reason, newFields: [] }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    source: "apify_gmaps",
    newFields,
    // Both of these flip the company to not_qualified. Say so, rather than
    // leaving someone to notice the status changed on its own.
    permanentlyClosed: result.permanently_closed_marked > 0,
    disqualified:
      after.row?.status === "not_qualified" && before.row?.status !== "not_qualified"
        ? String(after.row?.disqualify_reason ?? "out of scope")
        : null,
  });
}
