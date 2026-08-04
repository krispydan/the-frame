export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { captureListings, countRemaining, getGmapsProfile } from "@/modules/sales/lib/gmaps-profile";

/**
 * Customer Google Maps profiling.
 *
 * GET                       → the profile + ready-to-paste Apify actor input
 * GET  ?remaining=1         → how many listings are still to capture
 * POST { cohort, limit }    → capture a batch of listings
 *        cohort: "customers" (default) | "called-no-order"
 *
 * Auth: x-admin-key: jaxy2026.
 */

export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (new URL(req.url).searchParams.get("remaining") === "1") {
    return NextResponse.json({
      ok: true,
      customers: countRemaining("customers"),
      calledNoOrder: countRemaining("called-no-order"),
    });
  }
  return NextResponse.json({ ok: true, ...getGmapsProfile() });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const cohort = body.cohort === "called-no-order" ? "called-no-order" : "customers";
  const result = await captureListings({
    cohort,
    limit: Number(body.limit) || 50,
    verify: body.verify === true,
  });
  return NextResponse.json({ ok: true, cohort, ...result });
}
