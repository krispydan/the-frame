export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { exchangeXeroCode } from "@/modules/finance/lib/xero-client";
import { db } from "@/lib/db";
import { settings } from "@/modules/core/schema";

/**
 * GET /api/auth/xero/callback
 *
 * OAuth2 redirect target. Validates the CSRF state cookie set by
 * /api/auth/xero, exchanges the code for tokens via the Xero identity
 * server, and persists them to the settings key/value table (existing
 * pattern — to be moved to a dedicated xero_tokens table in Phase 1).
 *
 * Redirects to /settings/integrations/xero with a success or error banner.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");

  if (error) return errorRedirect(request, "xero_error", error);
  if (!code) return errorRedirect(request, "no_code", "Xero did not return an authorization code");
  if (!state) return errorRedirect(request, "no_state", "OAuth state missing");

  // Validate state cookie
  const cookieState = request.cookies.get("xero_oauth_state")?.value;
  if (!cookieState || cookieState !== state) {
    return errorRedirect(request, "state_mismatch", "OAuth state did not match — try connecting again");
  }

  const result = await exchangeXeroCode(code);
  if (!result.success || !result.tokens) {
    return errorRedirect(request, "token_exchange_failed", result.error || "Token exchange failed");
  }

  const tokenData = result.tokens;
  const entries = [
    { key: "xero_access_token",     value: tokenData.accessToken },
    { key: "xero_refresh_token",    value: tokenData.refreshToken },
    { key: "xero_token_expires_at", value: String(tokenData.expiresAt) },
    { key: "xero_tenant_id",        value: tokenData.tenantId || "" },
    { key: "xero_tenant_name",      value: tokenData.tenantName || "" },
    { key: "xero_connected_at",     value: new Date().toISOString() },
  ];
  for (const e of entries) {
    db.insert(settings)
      .values({ key: e.key, value: e.value, type: "string" as const, module: "finance" })
      .onConflictDoUpdate({ target: settings.key, set: { value: e.value, updatedAt: new Date().toISOString() } })
      .run();
  }

  // Slack: announce the new connection so the team knows
  void (async () => {
    try {
      const { notifyConnectedStore } = await import("@/modules/integrations/lib/slack/notifications");
      await notifyConnectedStore({ service: "Xero", identifier: tokenData.tenantName || "Xero" });
    } catch (e) {
      console.error("[xero/callback] Slack connected_store alert failed:", e);
    }
  })();

  // Redirect using absolute URL so we don't bounce to localhost behind Railway proxy
  const url = absoluteUrl("/settings/integrations/xero", request);
  url.searchParams.set("connected", tokenData.tenantName || "Xero");
  const response = NextResponse.redirect(url);
  response.cookies.delete("xero_oauth_state");
  return response;
}

function errorRedirect(request: NextRequest, code: string, message: string) {
  const url = absoluteUrl("/settings/integrations/xero", request);
  url.searchParams.set("error", code);
  url.searchParams.set("error_message", message);
  return NextResponse.redirect(url);
}

/** Same helper pattern as the Shopify OAuth callback. */
function absoluteUrl(target: string, request: NextRequest): URL {
  const envBase = process.env.SHOPIFY_APP_URL || process.env.XERO_APP_URL;
  if (envBase) return new URL(target, envBase.replace(/\/$/, ""));

  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto") || "https";
  if (forwardedHost) return new URL(target, `${forwardedProto}://${forwardedHost}`);

  return new URL(target, request.url);
}
