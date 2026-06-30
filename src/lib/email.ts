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

export async function sendLeadConvertedEmail(
  to: string,
  opts: {
    companyName: string;
    contactEmail?: string | null;
    firstContactAt?: string | null;
    orderTotal: string; // formatted, e.g. "$352"
    isFirstOrder: boolean;
    channel: string;
    prospectUrl?: string | null;
    duplicate?: { name: string; url?: string | null } | null;
  },
) {
  const subject = `🎉 Lead converted: ${opts.companyName} placed a wholesale order`;
  const faireNote = /faire/i.test(opts.channel)
    ? `<p style="color:#b45309;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:12px;">⚠️ This customer ordered on Faire — make sure you don't pay commission!</p>`
    : "";
  const dupNote = opts.duplicate
    ? `<p style="color:#3730a3;background:#eef2ff;border:1px solid #c7d2fe;border-radius:8px;padding:12px;">🔗 Looks like the same store as existing prospect <strong>${opts.duplicate.name}</strong>${opts.duplicate.url ? ` — <a href="${opts.duplicate.url}">review &amp; merge</a>` : ""}.</p>`
    : "";
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:32px 20px;">
      <h2 style="margin-bottom:8px;">You just converted a lead! 🎉</h2>
      <h3 style="margin:16px 0 4px;">${opts.companyName}</h3>
      <p style="margin:2px 0;color:#52525b;">${opts.firstContactAt ? `First contacted: ${new Date(opts.firstContactAt).toLocaleDateString()}` : ""}</p>
      ${opts.contactEmail ? `<p style="margin:2px 0;color:#52525b;">Contact: ${opts.contactEmail}</p>` : ""}
      <p style="margin:2px 0;color:#52525b;">${opts.isFirstOrder ? "Opening order size" : "Order size"}: <strong>${opts.orderTotal}</strong></p>
      ${opts.prospectUrl ? `<a href="${opts.prospectUrl}" style="display:inline-block;background:#18181b;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;margin:16px 0;">View in the frame</a>` : ""}
      ${dupNote}
      ${faireNote}
    </div>
  `;
  return sendEmail(to, subject, html);
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
