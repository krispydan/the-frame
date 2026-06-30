export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { exchangePipedriveCode } from "@/modules/sales/lib/pipedrive-client";

/**
 * GET /api/auth/pipedrive/callback
 *
 * OAuth2 redirect target. Validates the CSRF state cookie set by
 * /api/auth/pipedrive, exchanges the code for tokens (persisted to settings),
 * and bounces back to /settings/integrations with a banner.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");

  if (error) return errorRedirect(request, "pipedrive_error", error);
  if (!code) return errorRedirect(request, "no_code", "Pipedrive did not return an authorization code");
  if (!state) return errorRedirect(request, "no_state", "OAuth state missing");

  const cookieState = request.cookies.get("pipedrive_oauth_state")?.value;
  if (!cookieState || cookieState !== state) {
    return errorRedirect(request, "state_mismatch", "OAuth state did not match — try connecting again");
  }

  const result = await exchangePipedriveCode(code);
  if (!result.success) {
    return errorRedirect(request, "token_exchange_failed", result.error || "Token exchange failed");
  }

  // Slack: announce the connection (best-effort, mirrors the Xero callback).
  void (async () => {
    try {
      const { notifyConnectedStore } = await import("@/modules/integrations/lib/slack/notifications");
      await notifyConnectedStore({ service: "Pipedrive", identifier: result.apiDomain || "Pipedrive" });
    } catch (e) {
      console.error("[pipedrive/callback] Slack connected alert failed:", e);
    }
  })();

  const url = absoluteUrl("/settings/integrations", request);
  url.searchParams.set("connected", "Pipedrive");
  const response = NextResponse.redirect(url);
  response.cookies.delete("pipedrive_oauth_state");
  return response;
}

function errorRedirect(request: NextRequest, code: string, message: string) {
  const url = absoluteUrl("/settings/integrations", request);
  url.searchParams.set("error", code);
  url.searchParams.set("error_message", message);
  return NextResponse.redirect(url);
}

function absoluteUrl(target: string, request: NextRequest): URL {
  const envBase = process.env.PIPEDRIVE_APP_URL || process.env.SHOPIFY_APP_URL;
  if (envBase) return new URL(target, envBase.replace(/\/$/, ""));
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto") || "https";
  if (forwardedHost) return new URL(target, `${forwardedProto}://${forwardedHost}`);
  return new URL(target, request.url);
}
