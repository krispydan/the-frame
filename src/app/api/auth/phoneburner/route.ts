export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { pbAuthorizeUrl } from "@/modules/sales/lib/phoneburner-oauth";
import { PB_ACCOUNTS, type PbRep } from "@/modules/sales/lib/phoneburner-client";

/**
 * GET /api/auth/phoneburner?rep=christina
 *
 * Kicks off the PhoneBurner OAuth2 authorize flow for a rep. The rep must be
 * LOGGED INTO PhoneBurner as themselves in this browser (so the token they grant
 * belongs to their account). Requires the app's client_id to be stored first
 * (POST /api/admin/sales/phoneburner-setup with clientId+clientSecret).
 *
 * Sets a CSRF `state` cookie and 302s to PhoneBurner's authorize page.
 */
export function GET(req: NextRequest) {
  const rep = (new URL(req.url).searchParams.get("rep") || "christina") as PbRep;
  if (!PB_ACCOUNTS[rep]) {
    return NextResponse.json({ error: `unknown rep "${rep}"` }, { status: 400 });
  }
  let authorizeUrl: string;
  const state = `${rep}:${randomUUID()}`;
  try {
    authorizeUrl = pbAuthorizeUrl(rep, state);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set("pb_oauth_state", state, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/" });
  return res;
}
