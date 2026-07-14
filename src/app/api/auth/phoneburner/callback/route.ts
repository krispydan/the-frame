export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { exchangePhoneBurnerCode } from "@/modules/sales/lib/phoneburner-oauth";
import { PB_ACCOUNTS, type PbRep } from "@/modules/sales/lib/phoneburner-client";

/**
 * GET /api/auth/phoneburner/callback
 *
 * OAuth2 redirect target. Validates the CSRF state cookie set by
 * /api/auth/phoneburner, exchanges the code for tokens (access + refresh,
 * persisted to settings), discovers the rep's owner_id, and shows a small
 * status page. The rep in play is encoded in the state ("<rep>:<uuid>").
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) return page(false, `PhoneBurner returned an error: ${error}`);
  if (!code) return page(false, "No authorization code returned by PhoneBurner.");
  if (!state) return page(false, "OAuth state missing.");

  const cookieState = req.cookies.get("pb_oauth_state")?.value;
  if (!cookieState || cookieState !== state) {
    return page(false, "OAuth state did not match — start again from /api/auth/phoneburner?rep=christina.");
  }

  const rep = state.split(":")[0] as PbRep;
  if (!PB_ACCOUNTS[rep]) return page(false, `Unknown rep in state: ${rep}`);

  try {
    const { ownerId, expiresAt } = await exchangePhoneBurnerCode(rep, code);
    const res = page(
      true,
      `Connected ${rep}'s PhoneBurner account. Owner id: ${ownerId ?? "(discovers on first contact)"}. ` +
        `Token expires: ${expiresAt ?? "unknown"}. You can close this tab.`,
    );
    res.cookies.delete("pb_oauth_state");
    return res;
  } catch (e) {
    return page(false, e instanceof Error ? e.message : String(e));
  }
}

function page(ok: boolean, message: string): NextResponse {
  const html = `<!doctype html><meta charset="utf-8"><title>PhoneBurner ${ok ? "connected" : "error"}</title>
<div style="font-family:system-ui,sans-serif;max-width:560px;margin:64px auto;padding:24px;border-radius:12px;border:1px solid #e2e2e2">
<h2 style="margin-top:0">${ok ? "✅ PhoneBurner connected" : "⚠️ PhoneBurner connection failed"}</h2>
<p style="color:#444;line-height:1.5">${message.replace(/</g, "&lt;")}</p>
</div>`;
  return new NextResponse(html, { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8" } });
}
