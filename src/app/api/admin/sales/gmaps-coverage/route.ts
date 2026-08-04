export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * Google Maps coverage — how much of the book already carries a listing.
 *
 * Sizes any profiling work before it starts: re-scraping what we already hold
 * is pure Apify cost, and the customer subset is what a lookalike search should
 * be modelled on.
 *
 * Auth: x-admin-key: jaxy2026.
 */
export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // A customer is anyone who has actually bought — status alone misses
  // companies that ordered but were never re-classified.
  const isCustomer = `(c.status = 'customer' OR EXISTS (SELECT 1 FROM orders o
                         WHERE o.company_id = c.id AND o.status NOT IN ('cancelled','returned')))`;

  const counts = (where: string) =>
    sqlite.prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN c.google_place_id IS NOT NULL THEN 1 ELSE 0 END) withPlaceId,
              SUM(CASE WHEN c.gmaps_subtypes IS NOT NULL THEN 1 ELSE 0 END) withSubtypes,
              SUM(CASE WHEN c.google_review_count IS NOT NULL THEN 1 ELSE 0 END) withReviews,
              SUM(CASE WHEN c.gmaps_url IS NOT NULL THEN 1 ELSE 0 END) withMapsUrl
         FROM companies c ${where}`,
    ).get() as Record<string, number>;

  return NextResponse.json({
    ok: true,
    all: counts(""),
    customers: counts(`WHERE ${isCustomer}`),
    prospects: counts(`WHERE NOT ${isCustomer}`),
    // What Google calls our customers — the vocabulary a lookalike search
    // should actually use, rather than terms we guessed.
    customerSubtypes: sqlite.prepare(
      `SELECT c.gmaps_subtypes, COUNT(*) n FROM companies c
        WHERE ${isCustomer} AND c.gmaps_subtypes IS NOT NULL
        GROUP BY c.gmaps_subtypes ORDER BY n DESC LIMIT 20`,
    ).all(),
    customerReviewBands: sqlite.prepare(
      `SELECT CASE
                WHEN c.google_review_count IS NULL THEN 'unknown'
                WHEN c.google_review_count < 25 THEN '0-24'
                WHEN c.google_review_count < 100 THEN '25-99'
                WHEN c.google_review_count < 500 THEN '100-499'
                ELSE '500+' END band,
              COUNT(*) n, ROUND(AVG(c.google_rating), 2) avgRating
         FROM companies c WHERE ${isCustomer} GROUP BY band ORDER BY n DESC`,
    ).all(),
  });
}
