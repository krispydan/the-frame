export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/get-session";
import { getCompanyListing, captureOneListing, getGmapsProfile } from "@/modules/sales/lib/gmaps-profile";

/**
 * GET ?companyId=…   → that store's Google Maps listing (customer detail page)
 * GET ?profile=1     → the aggregate customer profile (analytics page)
 * POST { companyId } → capture/refresh one listing on demand
 *
 * Session-gated; refresh is limited to the roles that own the relationship.
 */

const REFRESH_ROLES = ["owner", "sales_manager", "marketing"];

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const p = req.nextUrl.searchParams;
  if (p.get("profile") === "1") {
    return NextResponse.json({ ok: true, profile: getGmapsProfile() });
  }

  const companyId = (p.get("companyId") || "").trim();
  if (!companyId) return NextResponse.json({ error: "companyId or profile=1 required" }, { status: 400 });

  return NextResponse.json({
    ok: true,
    listing: getCompanyListing(companyId),
    canRefresh: REFRESH_ROLES.includes(user.role),
  });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!REFRESH_ROLES.includes(user.role)) {
    return NextResponse.json({ error: "not permitted for your role" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const companyId = String(body.companyId || "");
  if (!companyId) return NextResponse.json({ error: "companyId required" }, { status: 400 });

  const result = await captureOneListing(companyId, { force: true });
  // Keep Pipedrive in step with a manual refresh — otherwise the rep-facing
  // copy silently drifts from what the frame shows.
  let pipedrive: unknown = null;
  if (result.status === "captured") {
    const { pushListingToPipedrive } = await import("@/modules/sales/lib/gmaps-pipedrive");
    pipedrive = await pushListingToPipedrive(companyId).catch((e) => ({ status: "error", reason: String(e) }));
  }
  return NextResponse.json({ ok: true, result, pipedrive, listing: getCompanyListing(companyId) });
}
