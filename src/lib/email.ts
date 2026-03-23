const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = "The Frame <noreply@theframe.getjaxy.com>";

async function sendEmail(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY) {
    console.error("[email] RESEND_API_KEY not set, skipping email to", to);
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("[email] Failed to send:", err);
    return { ok: false, error: err };
  }

  return { ok: true, data: await res.json() };
}

export async function sendInviteEmail(to: string, name: string, tempPassword: string, loginUrl: string) {
  const subject = "You've been invited to The Frame";
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto; padding: 40px 20px;">
      <h2 style="margin-bottom: 16px;">Welcome to The Frame, ${name}!</h2>
      <p>You've been invited to join The Frame — Jaxy's operations platform.</p>
      <p>Here are your temporary credentials:</p>
      <div style="background: #f4f4f5; border-radius: 8px; padding: 16px; margin: 20px 0;">
        <p style="margin: 4px 0;"><strong>Email:</strong> ${to}</p>
        <p style="margin: 4px 0;"><strong>Temporary Password:</strong> ${tempPassword}</p>
      </div>
      <p>Please log in and change your password right away:</p>
      <a href="${loginUrl}" style="display: inline-block; background: #18181b; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin: 16px 0;">Log In to The Frame</a>
      <p style="color: #71717a; font-size: 14px; margin-top: 24px;">If you didn't expect this invite, you can safely ignore this email.</p>
    </div>
  `;
  return sendEmail(to, subject, html);
}

export async function sendPasswordResetEmail(to: string, name: string, resetToken: string, resetUrl: string) {
  const subject = "Reset your password — The Frame";
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto; padding: 40px 20px;">
      <h2 style="margin-bottom: 16px;">Password Reset</h2>
      <p>Hi ${name}, we received a request to reset your password for The Frame.</p>
      <a href="${resetUrl}?token=${resetToken}" style="display: inline-block; background: #18181b; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin: 16px 0;">Reset Password</a>
      <p style="color: #71717a; font-size: 14px; margin-top: 24px;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
    </div>
  `;
  return sendEmail(to, subject, html);
}
