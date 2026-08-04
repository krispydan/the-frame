export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import {
  geocodeCompanies, countUngeocodedCustomers, geocodeDiagnostic, getGeocodeFailureBreakdown,
} from "@/modules/customers/lib/geocoding";

/**
 * Token-guarded geocoding ops (x-ops-key: OPS_TOKEN).
 *
 * GET  ?mode=count    → { remaining }                (default)
 *      ?mode=diag     → Nominatim reachability probe
 *      ?mode=failures → why the unmapped ones failed
 * POST ?confirm=1     → run one geocode batch
 *      body: { limit?, force?, retryFailed?, customersOnly? }
 */
export async function GET(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;

  const mode = req.nextUrl.searchParams.get("mode") ?? "count";
  if (mode === "diag") return NextResponse.json(await geocodeDiagnostic());
  if (mode === "failures") return NextResponse.json(getGeocodeFailureBreakdown());
  return NextResponse.json({ remaining: countUngeocodedCustomers() });
}

export async function POST(req: NextRequest) {
  const denied = requireOpsToken(req, { mutation: true });
  if (denied) return denied;

  let body: { limit?: number; force?: boolean; retryFailed?: boolean; customersOnly?: boolean } = {};
  try { body = await req.json(); } catch { /* empty ok */ }

  const result = await geocodeCompanies({
    limit: body.limit ?? 15,
    force: body.force ?? false,
    retryFailed: body.retryFailed ?? false,
    customersOnly: body.customersOnly ?? true,
  });
  return NextResponse.json({ ...result, remaining: countUngeocodedCustomers() });
}
