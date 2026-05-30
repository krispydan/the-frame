export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { aggregateCustomerProfile } from "@/modules/sales/lib/storeleads/lookalike-audience";

/**
 * GET /api/v1/integrations/storeleads/customer-profile
 *
 * Pure SQL aggregation over our locally-enriched customer rows —
 * cheap to call repeatedly. Returns the CustomerProfile shape used
 * by the lookalike-audience UI to preview what a search would target
 * before triggering it.
 */
export async function GET() {
  const profile = aggregateCustomerProfile();
  return NextResponse.json(profile);
}
