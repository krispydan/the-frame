export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import {
  bootstrapWithPassword,
  bootstrapWithRefreshToken,
} from "@/modules/operations/lib/shiphero/auth";

/**
 * POST /api/admin/shiphero/bootstrap
 *
 * One-time setup for ShipHero token rotation. After this runs, the daily
 * cron `shiphero-token-refresh` keeps the access token alive automatically
 * and api-client.ts self-heals on 401.
 *
 * Two modes:
 *
 *   { mode: "password", username, password }
 *     Calls the public-api password grant. Persists both the access token
 *     (28-day) and the long-lived refresh token (3650-day). Use when you
 *     have the ShipHero account password handy.
 *
 *   { mode: "refresh", refresh_token }
 *     You already have a refresh token (from the ShipHero developer portal
 *     or a prior bootstrap). Stores it and mints a fresh access token.
 *
 * Auth: x-admin-key: jaxy2026
 *
 * The response does NOT echo the refresh token (which is long-lived) or
 * the full access token — only a short preview so you can confirm the
 * call landed without leaking the credential in shell history.
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    mode?: string;
    username?: string;
    password?: string;
    refresh_token?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }

  try {
    if (body.mode === "password") {
      if (!body.username || !body.password) {
        return NextResponse.json(
          { error: "username + password required for mode=password" },
          { status: 400 },
        );
      }
      const r = await bootstrapWithPassword({
        username: body.username,
        password: body.password,
      });
      return NextResponse.json({
        ok: true,
        mode: "password",
        expires_at: r.expiresAt,
        access_token_preview: preview(r.accessToken),
        message:
          "Refresh token stored. Daily cron 'shiphero-token-refresh' will keep the access token alive.",
      });
    }

    if (body.mode === "refresh") {
      if (!body.refresh_token) {
        return NextResponse.json(
          { error: "refresh_token required for mode=refresh" },
          { status: 400 },
        );
      }
      const r = await bootstrapWithRefreshToken(body.refresh_token);
      return NextResponse.json({
        ok: true,
        mode: "refresh",
        expires_at: r.expiresAt,
        access_token_preview: preview(r.accessToken),
        message:
          "Refresh token stored. Daily cron 'shiphero-token-refresh' will keep the access token alive.",
      });
    }

    return NextResponse.json(
      { error: "mode must be 'password' or 'refresh'" },
      { status: 400 },
    );
  } catch (e) {
    const err = e as Error;
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

function preview(token: string): string {
  if (token.length < 30) return "***";
  return `${token.slice(0, 12)}...${token.slice(-6)}`;
}
