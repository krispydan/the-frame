const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = "The Frame <noreply@theframe.getjaxy.com>";

type Attachment = { filename: string; content: string }; // content = base64

interface SendEmailOptions {
  cc?: string;
  replyTo?: string;
  from?: string;
}

async function sendEmail(
  to: string,
  subject: string,
  html: string,
  attachments?: Attachment[],
  opts?: SendEmailOptions,
) {
  if (!RESEND_API_KEY) {
    console.error("[email] RESEND_API_KEY not set, skipping email to", to);
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }

  // `to` may be a comma/semicolon-separated list (e.g. a shared team inbox +
  // an individual). Split into the array Resend expects; a single address
  // just yields a one-element array (unchanged behavior for existing callers).
  const recipients = to.split(/[,;]/).map((r) => r.trim()).filter(Boolean);
  const body: Record<string, unknown> = {
    from: opts?.from || FROM_ADDRESS,
    to: recipients,
    subject,
    html,
  };
  if (attachments?.length) body.attachments = attachments;
  if (opts?.cc) body.cc = opts.cc.split(/[,;]/).map((r) => r.trim()).filter(Boolean);
  if (opts?.replyTo) body.reply_to = opts.replyTo;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("[email] Failed to send:", err);
    return { ok: false, error: err };
  }

  return { ok: true, data: await res.json() };
}

// ── International Shipping (3PL dims request) ──

export interface InternationalShippingEmailInput {
  orderNumber: string;      // Shopify order name, e.g. "G4JWGQ7J94"
  country: string;          // ship-to country
  faireOrderUrl: string | null;
  shipheroOrderUrl: string | null;
  to?: string;              // defaults to the warehouse
  cc?: string;              // defaults to wholesale@getjaxy.com
  replyTo?: string;         // defaults to wholesale@getjaxy.com
}

/**
 * Email the 3PL warehouse asking for packaged dims + weight on a non-US
 * Faire order, so we can generate the Faire shipping label. Sends FROM the
 * Resend-verified domain but sets reply-to/cc to wholesale@ so their reply
 * lands in the right inbox.
 */
export async function sendInternationalShippingDimsEmail(input: InternationalShippingEmailInput) {
  const to = input.to || "team@bigskyfulfillment.com";
  const cc = input.cc || "wholesale@getjaxy.com";
  const replyTo = input.replyTo || "wholesale@getjaxy.com";
  const subject = `${input.orderNumber} DIMs for International Shipment`;

  const linksHtml = [
    input.faireOrderUrl ? `<li><a href="${input.faireOrderUrl}">Order in Faire</a></li>` : "",
    input.shipheroOrderUrl ? `<li><a href="${input.shipheroOrderUrl}">Order in ShipHero</a></li>` : "",
  ].filter(Boolean).join("");

  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#18181b;max-width:560px;line-height:1.6;">
    <p>Hi Big Sky team,</p>
    <p>We have a new international Faire order (shipping to <strong>${input.country}</strong>) that needs shipping-label creation on our end. Before we can generate the label, we need the packaged dimensions and weight from you.</p>
    <p><strong>Order #:</strong> ${input.orderNumber}</p>
    <p>Please reply to this email with the following once the order is picked and packed:</p>
    <ul style="margin:0 0 16px 0;padding-left:20px;">
      <li>Length:</li>
      <li>Width:</li>
      <li>Height:</li>
      <li>Weight:</li>
    </ul>
    <p style="color:#666;">If it's more than one box, please give us the dims/weight for each box.</p>
    <p style="background:#FEF3C7;border-left:3px solid #B37800;padding:10px 14px;border-radius:4px;">
      <strong>Please DO NOT ship the order yet.</strong> International Faire orders require us to generate the shipping label through Faire's system. Once you send us the dims, we'll create the label, upload it to ShipHero, and let you know it's ready to ship.
    </p>
    ${linksHtml ? `
    <p style="margin-top:20px;"><strong>Links — for internal purposes</strong></p>
    <ul style="margin:0 0 16px 0;padding-left:20px;">${linksHtml}</ul>` : ""}
    <p>Thanks!<br/>Jaxy team</p>
  </div>`;

  return sendEmail(to, subject, html, undefined, { cc, replyTo });
}

/** One campaign the lead was part of, with its email + call touchpoints. */
export interface CampaignTouch {
  name: string;
  channelLabel: string; // "Email · Calls"
  firstTouchAt: string | null;
  openedAt: string | null;
  repliedAt: string | null;
  replyClassification: string | null;
  callCount: number;
  lastCalledAt: string | null;
  lastCallDisposition: string | null;
}

/** One logged phone call touchpoint. */
export interface CallTouch {
  calledAt: string | null;
  disposition: string | null;
  durationSeconds: number | null;
  connected: boolean;
}

/** The full campaign + activity history for a converted lead. */
export interface LeadTouchpoints {
  campaigns: CampaignTouch[];
  calls: CallTouch[];
  totals: { campaigns: number; emailsSent: number; opens: number; replies: number; calls: number; connectedCalls: number };
}

/** Pipedrive org + deal links for a converted lead, when synced. */
export interface LeadPipedrive {
  orgUrl: string | null;
  dealUrl: string | null;
  dealTitle: string | null;
  dealValue: number | null;
  dealStatus: string | null; // open | won | lost
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "";
  const d = new Date(s.includes("T") || s.includes(" ") ? s.replace(" ", "T") : s);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Renders the "how we won them" section: every campaign + touchpoint. */
function renderTouchpoints(tp?: LeadTouchpoints | null): string {
  if (!tp || (!tp.campaigns.length && !tp.calls.length)) return "";
  const t = tp.totals;
  const summary = [
    `${t.campaigns} campaign${t.campaigns === 1 ? "" : "s"}`,
    t.emailsSent ? `${t.emailsSent} email${t.emailsSent === 1 ? "" : "s"} sent` : "",
    t.opens ? `${t.opens} open${t.opens === 1 ? "" : "s"}` : "",
    t.replies ? `${t.replies} repl${t.replies === 1 ? "y" : "ies"}` : "",
    t.calls ? `${t.calls} call${t.calls === 1 ? "" : "s"}${t.connectedCalls ? ` (${t.connectedCalls} connected)` : ""}` : "",
  ].filter(Boolean);

  const campaignRows = tp.campaigns
    .map((c) => {
      const line2: string[] = [];
      if (c.firstTouchAt) line2.push(`First touch ${fmtDate(c.firstTouchAt)}`);
      if (c.openedAt) line2.push(`Opened ${fmtDate(c.openedAt)}`);
      if (c.repliedAt) line2.push(`Replied ${fmtDate(c.repliedAt)}${c.replyClassification ? ` · ${esc(c.replyClassification)}` : ""}`);
      if (c.callCount) line2.push(`${c.callCount} call${c.callCount === 1 ? "" : "s"}${c.lastCallDisposition ? ` · last: ${esc(c.lastCallDisposition)}` : ""}`);
      return `
        <tr>
          <td style="padding:8px 0;border-top:1px solid #f0f0f0;">
            <div style="font-weight:600;color:#18181b;">${esc(c.name)}${c.channelLabel ? ` <span style="font-weight:400;color:#a1a1aa;font-size:12px;">${esc(c.channelLabel)}</span>` : ""}</div>
            ${line2.length ? `<div style="color:#71717a;font-size:13px;margin-top:2px;">${line2.join(" &nbsp;·&nbsp; ")}</div>` : ""}
          </td>
        </tr>`;
    })
    .join("");

  // Individual call log (recent first), only if there are logged calls.
  const callRows = tp.calls
    .slice()
    .reverse()
    .slice(0, 8)
    .map((c) => {
      const dur = c.durationSeconds ? ` · ${Math.round(c.durationSeconds / 60)}m` : "";
      return `<div style="color:#71717a;font-size:13px;margin:2px 0;">📞 ${fmtDate(c.calledAt) || "—"} — ${esc(c.disposition) || (c.connected ? "connected" : "no answer")}${dur}</div>`;
    })
    .join("");

  return `
    <div style="margin-top:24px;padding-top:16px;border-top:2px solid #e4e4e7;">
      <h3 style="margin:0 0 4px;">How we won them</h3>
      <p style="margin:0 0 12px;color:#3f3f46;font-size:14px;">${summary.join(" &nbsp;·&nbsp; ")}</p>
      <table style="width:100%;border-collapse:collapse;">${campaignRows}</table>
      ${callRows ? `<div style="margin-top:12px;"><div style="font-weight:600;color:#18181b;font-size:14px;margin-bottom:4px;">Call log</div>${callRows}</div>` : ""}
    </div>`;
}

/** Renders the Pipedrive deal + org links, when the lead is synced. */
function renderPipedrive(pd?: LeadPipedrive | null): string {
  if (!pd || (!pd.orgUrl && !pd.dealUrl)) return "";
  const links: string[] = [];
  if (pd.dealUrl) {
    const label = `View deal${pd.dealStatus ? ` (${esc(pd.dealStatus)})` : ""} in Pipedrive →`;
    links.push(`<a href="${pd.dealUrl}" style="color:#18181b;font-weight:600;">${label}</a>`);
  }
  if (pd.orgUrl) links.push(`<a href="${pd.orgUrl}" style="color:#18181b;font-weight:600;">View organization →</a>`);
  return `<p style="margin:12px 0 0;font-size:14px;">🟢 ${links.join(" &nbsp;·&nbsp; ")}</p>`;
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
    touchpoints?: LeadTouchpoints | null;
    pipedrive?: LeadPipedrive | null;
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
      ${renderPipedrive(opts.pipedrive)}
      ${dupNote}
      ${faireNote}
      ${renderTouchpoints(opts.touchpoints)}
    </div>
  `;
  return sendEmail(to, subject, html);
}

/**
 * Weekly Faire customer-upload digest. Attaches a CSV of interested leads to
 * upload into Faire's Customers bulk uploader (Faire Direct + Campaigns), so
 * they get added to Faire and subscribed to the brand's Faire emails.
 */
export async function sendFaireCustomerExportEmail(
  to: string,
  opts: { count: number; withoutEmail: number; csv: string; filename: string; weekLabel: string },
) {
  const subject =
    opts.count > 0
      ? `📇 ${opts.count} interested lead${opts.count === 1 ? "" : "s"} to add to Faire (${opts.weekLabel})`
      : `📇 No new interested leads to add to Faire (${opts.weekLabel})`;
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:32px 20px;">
      <h2 style="margin-bottom:8px;">Weekly Faire customer upload</h2>
      ${
        opts.count > 0
          ? `<p style="color:#3f3f46;">Attached is a CSV of <strong>${opts.count}</strong> interested lead${opts.count === 1 ? "" : "s"} with an email on file. Upload it in the Faire brand portal under <strong>Customers → Add customers (bulk upload)</strong>, then use <strong>Campaigns</strong> to email them. The <em>Source</em> column carries where each lead came from.</p>
             <p style="color:#71717a;font-size:14px;">These are marked as exported, so next week's email only includes new interested leads.</p>`
          : `<p style="color:#3f3f46;">No new interested leads with an email since last week — nothing to upload. You'll get the next batch when new leads come in.</p>`
      }
      ${opts.withoutEmail > 0 ? `<p style="color:#b45309;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:10px;font-size:14px;">${opts.withoutEmail} interested lead${opts.withoutEmail === 1 ? " has" : "s have"} no email on file and were skipped (Faire needs an email to subscribe them).</p>` : ""}
    </div>`;
  const attachments =
    opts.count > 0 ? [{ filename: opts.filename, content: Buffer.from(opts.csv, "utf-8").toString("base64") }] : undefined;
  return sendEmail(to, subject, html, attachments);
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
