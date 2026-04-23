export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { SignJWT } from "jose";

const secret = new TextEncoder().encode(process.env.NEXTAUTH_SECRET || "dev-secret-change-me");

function getBaseUrl() {
  if (process.env.NEXTAUTH_URL) return process.env.NEXTAUTH_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return "http://localhost:3456";
}

export async function GET(req: NextRequest) {
  const baseUrl = getBaseUrl();
  const token = req.nextUrl.searchParams.get("token");

  if (!token) {
    return NextResponse.redirect(`${baseUrl}/login?error=expired`);
  }

  // Look up token
  const record = sqlite
    .prepare("SELECT id, email, token, expires_at, used FROM magic_link_tokens WHERE token = ?")
    .get(token) as { id: string; email: string; token: string; expires_at: string; used: number } | undefined;

  if (!record || record.used) {
    return NextResponse.redirect(`${baseUrl}/login?error=expired`);
  }

  // Check expiry
  if (new Date(record.expires_at) < new Date()) {
    return NextResponse.redirect(`${baseUrl}/login?error=expired`);
  }

  // Mark as used
  sqlite.prepare("UPDATE magic_link_tokens SET used = 1 WHERE id = ?").run(record.id);

  // Look up user
  const user = sqlite
    .prepare("SELECT id, email, name, role, is_active FROM users WHERE email = ?")
    .get(record.email) as { id: string; email: string; name: string; role: string; is_active: number } | undefined;

  if (!user || !user.is_active) {
    return NextResponse.redirect(`${baseUrl}/login?error=expired`);
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
    .setExpirationTime("30d")
    .sign(secret);

  // Update last login
  sqlite.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(new Date().toISOString(), user.id);

  const response = NextResponse.redirect(`${baseUrl}/dashboard`);
  response.cookies.set("session-token", jwt, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60,
    path: "/",
  });

  return response;
}
