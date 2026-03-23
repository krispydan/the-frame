import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import bcrypt from "bcryptjs";

// POST /api/v1/auth/set-password — validate token and set new password
export async function POST(req: NextRequest) {
  const { token, password } = await req.json();
  if (!token || !password) {
    return NextResponse.json({ error: "Token and password are required" }, { status: 400 });
  }

  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }

  const user = sqlite
    .prepare("SELECT id, password_reset_expires FROM users WHERE password_reset_token = ? AND is_active = 1")
    .get(token) as { id: string; password_reset_expires: string } | undefined;

  if (!user) {
    return NextResponse.json({ error: "Invalid or expired reset token" }, { status: 400 });
  }

  if (new Date(user.password_reset_expires) < new Date()) {
    return NextResponse.json({ error: "Reset token has expired" }, { status: 400 });
  }

  const hash = await bcrypt.hash(password, 10);
  sqlite
    .prepare("UPDATE users SET password_hash = ?, password_reset_token = NULL, password_reset_expires = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(hash, user.id);

  return NextResponse.json({ ok: true });
}
