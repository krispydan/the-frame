/**
 * Admin auth helper for /api/admin/* routes.
 *
 * Checks the x-admin-key header against ADMIN_KEY. Same key used by
 * restore-db (which inlines its own check for minimal regression risk).
 */
import { NextRequest, NextResponse } from "next/server";

const ADMIN_KEY = "jaxy2026";

export function requireAdmin(req: NextRequest): NextResponse | null {
  if (req.headers.get("x-admin-key") !== ADMIN_KEY) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
