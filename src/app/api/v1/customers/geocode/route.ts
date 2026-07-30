export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { geocodeCompanies, countUngeocodedCustomers } from "@/modules/customers/lib/geocoding";

/**
 * GET /api/v1/customers/geocode → how many customers still need geocoding
 */
export async function GET() {
  return NextResponse.json({ remaining: countUngeocodedCustomers() });
}

/**
 * POST /api/v1/customers/geocode
 * Body: { limit?: number, force?: boolean, customersOnly?: boolean }
 * Geocodes a batch of customer companies (rate-limited ~1/sec via Nominatim).
 * Call repeatedly until `remaining` hits 0.
 */
export async function POST(request: NextRequest) {
  let body: { limit?: number; force?: boolean; customersOnly?: boolean } = {};
  try { body = await request.json(); } catch { /* empty body ok */ }
  const result = await geocodeCompanies({
    limit: body.limit ?? 100,
    force: body.force ?? false,
    customersOnly: body.customersOnly ?? true,
  });
  return NextResponse.json({ ...result, remaining: countUngeocodedCustomers() });
}
