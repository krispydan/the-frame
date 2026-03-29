export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { SignJWT } from "jose";

const secret = new TextEncoder().encode(process.env.NEXTAUTH_SECRET || "dev-secret-change-me");

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");

  if (!token) {
    return NextResponse.redirect(new URL("/login?error=expired", req.url));
  }

  // Look up token
  const record = sqlite
    .prepare("SELECT id, email, token, expires_at, used FROM magic_link_tokens WHERE token = ?")
    .get(token) as { id: string; email: string; token: string; expires_at: string; used: number } | undefined;

  if (!record || record.used) {
    return NextResponse.redirect(new URL("/login?error=expired", req.url));
  }

  // Check expiry
  if (new Date(record.expires_at) < new Date()) {
    return NextResponse.redirect(new URL("/login?error=expired", req.url));
  }

  // Mark as used
  sqlite.prepare("UPDATE magic_link_tokens SET used = 1 WHERE id = ?").run(record.id);

  // Look up user
  const user = sqlite
    .prepare("SELECT id, email, name, role, is_active FROM users WHERE email = ?")
    .get(record.email) as { id: string; email: string; name: string; role: string; is_active: number } | undefined;

  if (!user || !user.is_active) {
    return NextResponse.redirect(new URL("/login?error=expired", req.url));
  }

  // Create JWT session (same as manual-login route)
  const jwt = await new SignJWT({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret);

  // Update last login
  sqlite.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(new Date().toISOString(), user.id);

  const response = NextResponse.redirect(new URL("/dashboard", req.url));
  response.cookies.set("session-token", jwt, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60,
    path: "/",
  });

  return response;
}
