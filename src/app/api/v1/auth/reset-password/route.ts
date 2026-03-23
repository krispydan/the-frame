import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { sendPasswordResetEmail } from "@/lib/email";

// POST /api/v1/auth/reset-password — generate token and send email
export async function POST(req: NextRequest) {
  const { email } = await req.json();
  if (!email) return NextResponse.json({ error: "Email is required" }, { status: 400 });

  const user = sqlite
    .prepare("SELECT id, name, email FROM users WHERE email = ? AND is_active = 1")
    .get(email) as { id: string; name: string; email: string } | undefined;

  // Always return success to avoid email enumeration
  if (!user) return NextResponse.json({ ok: true });

  const token = crypto.randomUUID();
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

  sqlite
    .prepare("UPDATE users SET password_reset_token = ?, password_reset_expires = ? WHERE id = ?")
    .run(token, expires, user.id);

  const baseUrl = process.env.NEXTAUTH_URL || "https://theframe.getjaxy.com";
  await sendPasswordResetEmail(user.email, user.name, token, `${baseUrl}/reset-password`);

  return NextResponse.json({ ok: true });
}
