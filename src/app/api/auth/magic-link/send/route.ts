export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MIN = 5;
const TOKEN_EXPIRY_MIN = 15;

export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();

    if (!email || typeof email !== "string") {
      return NextResponse.json(
        { success: true, message: "If that email exists, we sent a magic link" },
        { status: 200 }
      );
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Rate limit: check recent tokens for this email
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MIN * 60 * 1000).toISOString();
    const recentTokens = sqlite
      .prepare("SELECT COUNT(*) as count FROM magic_link_tokens WHERE email = ? AND created_at > ?")
      .get(normalizedEmail, windowStart) as { count: number };

    if (recentTokens.count >= RATE_LIMIT_MAX) {
      return NextResponse.json(
        { success: true, message: "If that email exists, we sent a magic link" },
        { status: 200 }
      );
    }

    // Check if user exists
    const user = sqlite
      .prepare("SELECT id, email, is_active FROM users WHERE email = ?")
      .get(normalizedEmail) as { id: string; email: string; is_active: number } | undefined;

    if (!user || !user.is_active) {
      return NextResponse.json(
        { success: true, message: "If that email exists, we sent a magic link" },
        { status: 200 }
      );
    }

    // Generate token
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MIN * 60 * 1000).toISOString();

    sqlite
      .prepare("INSERT INTO magic_link_tokens (id, email, token, expires_at, used, created_at) VALUES (?, ?, ?, ?, 0, datetime('now'))")
      .run(crypto.randomUUID(), normalizedEmail, token, expiresAt);

    // Build verify URL
    const appUrl = process.env.NEXTAUTH_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "http://localhost:3000");
    const verifyUrl = `${appUrl}/api/auth/magic-link/verify?token=${token}`;

    // Send email via Resend
    await resend.emails.send({
      from: "noreply@getjaxy.com",
      to: normalizedEmail,
      subject: "Sign in to The Frame",
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 460px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          <tr>
            <td style="padding: 32px 32px 24px; text-align: center;">
              <div style="display: inline-block; width: 48px; height: 48px; line-height: 48px; background-color: #18181b; color: #ffffff; border-radius: 10px; font-weight: 700; font-size: 16px; text-align: center;">TF</div>
              <h1 style="margin: 16px 0 4px; font-size: 22px; font-weight: 700; color: #18181b;">The Frame</h1>
              <p style="margin: 0; font-size: 11px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase; color: #a1a1aa;">by Jaxy</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 32px 32px;">
              <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.6; color: #3f3f46;">Click the button below to sign in to your account. This link expires in 15 minutes.</p>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <a href="${verifyUrl}" style="display: inline-block; padding: 12px 32px; background-color: #18181b; color: #ffffff; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600;">Sign in to The Frame</a>
                  </td>
                </tr>
              </table>
              <p style="margin: 24px 0 0; font-size: 13px; line-height: 1.5; color: #71717a;">If you didn't request this email, you can safely ignore it.</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 16px 32px; background-color: #fafafa; border-top: 1px solid #f4f4f5;">
              <p style="margin: 0; font-size: 12px; color: #a1a1aa; text-align: center;">Jaxy &mdash; Eyewear Operations Platform</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
    });

    return NextResponse.json(
      { success: true, message: "If that email exists, we sent a magic link" },
      { status: 200 }
    );
  } catch (error) {
    console.error("Magic link send error:", error);
    return NextResponse.json(
      { success: true, message: "If that email exists, we sent a magic link" },
      { status: 200 }
    );
  }
}
