export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { exchangeCode, type PbRep } from "@/modules/sales/lib/phoneburner-oauth";

/**
 * GET /api/auth/phoneburner/callback?code=...&state=<rep>
 *
 * PhoneBurner OAuth redirect target. `state` carries the rep the token
 * belongs to (christina | sandra). Exchanges the code for tokens (stored
 * per-rep) and shows a simple result page.
 */
function page(title: string, body: string, ok: boolean): NextResponse {
  return new NextResponse(
    `<!doctype html><meta charset=utf-8><title>${title}</title>
     <div style="font-family:-apple-system,Segoe UI,Arial;max-width:560px;margin:60px auto;padding:24px;border-radius:12px;border:1px solid #e6e8ec">
       <h2 style="color:${ok ? "#16a34a" : "#dc2626"}">${title}</h2>
       <p style="color:#374151;line-height:1.6">${body}</p>
     </div>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = (req.nextUrl.searchParams.get("state") || "").toLowerCase();
  const error = req.nextUrl.searchParams.get("error");

  if (error) return page("PhoneBurner authorization failed", `PhoneBurner returned: ${error}`, false);
  if (!code) return page("Missing code", "PhoneBurner did not return an authorization code.", false);
  const rep = (["christina", "sandra"].includes(state) ? state : "christina") as PbRep;

  const r = await exchangeCode(rep, code);
  if (!r.ok) return page("Token exchange failed", `${r.error}`, false);
  return page(
    `✅ ${rep[0].toUpperCase() + rep.slice(1)}'s PhoneBurner is connected`,
    "Access + refresh tokens saved. The Frame will now call PhoneBurner as this rep and auto-refresh the token. You can close this tab.",
    true,
  );
}
