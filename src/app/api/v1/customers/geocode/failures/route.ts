export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET /api/v1/customers/geocode/failures
 *
 * Explains WHY the still-unmapped customer companies (latitude IS NULL)
 * couldn't be geocoded, by inspecting the address data actually on file and
 * bucketing each into a reason. This answers "what's the issue with the ones
 * that couldn't be located?" without having to eyeball the DB.
 *
 * Reason buckets (mirrors buildQuery / buildCoarseQuery in geocoding.ts):
 *   - not_attempted   : geocoded_at IS NULL — just hasn't been run yet
 *   - no_location_data: no address, city, state, zip, or country at all
 *   - insufficient    : has *something* (e.g. only zip or only country) but not
 *                       enough for even a coarse city/state lookup
 *   - unresolved      : had a usable address/city+state but Nominatim returned
 *                       no match — genuine data-quality issue (typo, freeform
 *                       address, non-standard international format, etc.)
 */
export async function GET() {
  const rows = sqlite.prepare(`
    SELECT c.id, c.name, c.address, c.city, c.state, c.zip, c.country,
           c.geocoded_at AS geocodedAt
    FROM companies c
    JOIN customer_accounts ca ON ca.company_id = c.id
    WHERE c.latitude IS NULL
    ORDER BY ca.lifetime_value DESC
  `).all() as Array<{
    id: string; name: string;
    address: string | null; city: string | null; state: string | null;
    zip: string | null; country: string | null; geocodedAt: string | null;
  }>;

  const t = (v: string | null) => (v ? v.trim() : "");
  const classify = (r: (typeof rows)[number]): string => {
    if (!r.geocodedAt) return "not_attempted";
    const hasAddress = !!t(r.address);
    const hasCity = !!t(r.city);
    const hasState = !!t(r.state);
    const hasAny = hasAddress || hasCity || hasState || !!t(r.zip) || !!t(r.country);
    if (!hasAny) return "no_location_data";
    // buildQuery needs a street address OR (city AND state);
    // buildCoarseQuery needs city OR state. If neither is satisfiable, the
    // row never even hit the network.
    const queryable = hasAddress || (hasCity && hasState) || hasCity || hasState;
    if (!queryable) return "insufficient";
    return "unresolved";
  };

  const REASON_LABELS: Record<string, string> = {
    not_attempted: "Not geocoded yet — click Geocode/Retry",
    no_location_data: "No address on file at all",
    insufficient: "Only partial data (e.g. zip or country only) — not enough to place",
    unresolved: "Address exists but the geocoder couldn't match it (bad/freeform/international)",
  };

  const summary: Record<string, number> = {};
  const examples: Record<string, Array<Record<string, string | null>>> = {};
  for (const r of rows) {
    const reason = classify(r);
    summary[reason] = (summary[reason] ?? 0) + 1;
    (examples[reason] ??= []);
    if (examples[reason].length < 10) {
      examples[reason].push({
        name: r.name,
        address: r.address, city: r.city, state: r.state, zip: r.zip, country: r.country,
      });
    }
  }

  return NextResponse.json({
    totalUnmapped: rows.length,
    summary: Object.entries(summary)
      .map(([reason, count]) => ({ reason, label: REASON_LABELS[reason] ?? reason, count }))
      .sort((a, b) => b.count - a.count),
    examples,
  });
}
