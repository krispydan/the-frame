import { NextRequest, NextResponse } from "next/server";

/**
 * DEPRECATED: legacy Xero OAuth callback path.
 *
 * The active callback now lives at /api/auth/xero/callback to match the
 * Shopify pattern and to use the absolute-URL redirect helper that survives
 * Railway's reverse proxy.
 *
 * This route forwards the OAuth query params (code, state, error) to the
 * new path so any Xero app config still pointing here keeps working
 * during the cutover. Update your Xero app's Redirect URI to
 * /api/auth/xero/callback at your earliest convenience.
 */
export async function GET(request: NextRequest) {
  const url = new URL("/api/auth/xero/callback", request.url);
  request.nextUrl.searchParams.forEach((value, key) => url.searchParams.set(key, value));
  return NextResponse.redirect(url, { status: 308 });
}
