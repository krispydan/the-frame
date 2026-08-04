import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

/**
 * Shared auth for the operator/recovery endpoints under /api/admin/ops/*.
 *
 * These routes are exempt from the NextAuth session middleware (see
 * src/middleware.ts — /api/admin is public) so they can be driven by tooling
 * without a browser session. They gate on a single shared secret instead:
 * the `x-ops-key` header (or `?ops_key=`) must equal process.env.OPS_TOKEN.
 *
 * Set OPS_TOKEN as a Railway env var — never commit it, never log it.
 * Rotate/revoke by changing the env var.
 *
 * Design:
 *  - GET (read-only diagnostics) needs only the token.
 *  - POST (mutations) needs the token AND ?confirm=1, so a write is always an
 *    explicit act, never an accidental one.
 */

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Returns null when the request is authorized; otherwise a NextResponse to
 * return immediately. `mutation: true` additionally requires ?confirm=1.
 */
export function requireOpsToken(req: NextRequest, opts?: { mutation?: boolean }): NextResponse | null {
  const expected = process.env.OPS_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: "OPS_TOKEN is not configured on the server." },
      { status: 503 },
    );
  }
  const provided =
    req.headers.get("x-ops-key") ?? req.nextUrl.searchParams.get("ops_key") ?? "";
  if (!provided || !safeEqual(provided, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (opts?.mutation && req.nextUrl.searchParams.get("confirm") !== "1") {
    return NextResponse.json(
      { error: "This is a mutation — re-send with ?confirm=1 to proceed." },
      { status: 428 }, // Precondition Required
    );
  }
  return null;
}
