export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getGeocodeFailureBreakdown } from "@/modules/customers/lib/geocoding";

/**
 * GET /api/v1/customers/geocode/failures  (session-guarded)
 * Explains why the still-unmapped customer companies couldn't be geocoded.
 * Shared logic lives in geocoding.ts (also used by the ops surface).
 */
export async function GET() {
  return NextResponse.json(getGeocodeFailureBreakdown());
}
