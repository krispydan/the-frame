export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { setOAuthConfig, buildAuthorizeUrl, oauthStatus, refreshRep, type PbRep } from "@/modules/sales/lib/phoneburner-oauth";

/**
 * GET  /api/admin/phoneburner/oauth-config → status + authorize URLs
 * POST /api/admin/phoneburner/oauth-config → set app creds
 *        body: { clientId, clientSecret, redirectUri? }
 *      or     { refresh: "christina" | "sandra" } to force a token refresh
 * Auth: x-admin-key: jaxy2026
 */
export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    ok: true,
    status: oauthStatus(),
    authorize_urls: { christina: buildAuthorizeUrl("christina"), sandra: buildAuthorizeUrl("sandra") },
  });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    clientId?: string; clientSecret?: string; redirectUri?: string; refresh?: string;
  };
  if (body.refresh) {
    const r = await refreshRep(body.refresh as PbRep);
    return NextResponse.json({ ok: r.ok, error: r.error, status: oauthStatus() });
  }
  if (!body.clientId || !body.clientSecret) {
    return NextResponse.json({ error: "clientId + clientSecret required" }, { status: 400 });
  }
  setOAuthConfig(body.clientId, body.clientSecret, body.redirectUri);
  return NextResponse.json({
    ok: true,
    status: oauthStatus(),
    authorize_urls: { christina: buildAuthorizeUrl("christina"), sandra: buildAuthorizeUrl("sandra") },
  });
}
