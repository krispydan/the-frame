export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { getPipedriveAuthUrl } from "@/modules/sales/lib/pipedrive-client";

/**
 * GET /api/auth/pipedrive
 *
 * Starts the Pipedrive OAuth2 flow: mints a CSRF state nonce, stores it in an
 * HTTP-only cookie, and redirects to Pipedrive's consent screen. The cookie is
 * validated by /api/auth/pipedrive/callback.
 */
export async function GET(_request: NextRequest) {
  const state = crypto.randomBytes(24).toString("hex");
  const authUrl = getPipedriveAuthUrl(state);
  if (!authUrl) {
    return NextResponse.json(
      { error: "Pipedrive is not configured. Set PIPEDRIVE_CLIENT_ID and PIPEDRIVE_CLIENT_SECRET." },
      { status: 500 },
    );
  }
  const response = NextResponse.redirect(authUrl);
  response.cookies.set("pipedrive_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  return response;
}
