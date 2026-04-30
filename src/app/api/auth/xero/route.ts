export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { getXeroAuthUrl } from "@/modules/finance/lib/xero-client";

/**
 * GET /api/auth/xero
 *
 * Starts the Xero OAuth2 flow. Generates a CSRF state nonce, sets it in an
 * HTTP-only cookie, and redirects the merchant to Xero's consent screen.
 *
 * The cookie is read by /api/auth/xero/callback to validate the round-trip.
 */
export async function GET(_request: NextRequest) {
  const authUrlBase = getXeroAuthUrl();
  if (!authUrlBase) {
    return NextResponse.json({
      error: "Xero is not configured. Set XERO_CLIENT_ID and XERO_CLIENT_SECRET env vars.",
    }, { status: 500 });
  }

  // Override the state in the URL with our own and persist it via cookie
  const state = crypto.randomBytes(24).toString("hex");
  const url = new URL(authUrlBase);
  url.searchParams.set("state", state);

  const response = NextResponse.redirect(url);
  response.cookies.set("xero_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,  // 10 minutes
    path: "/",  // root path so it survives the Xero -> /api/auth/xero/callback hop reliably
  });

  return response;
}
