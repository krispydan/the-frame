/**
 * Slack notification for "Interested lead" events from PhoneBurner.
 *
 * Fired by the phoneburner-webhooks handler whenever a call ends with
 * a "Set Appointment" disposition (or any disposition that maps to
 * companies.status='interested'). Posts to the `sales.phoneburner_interested`
 * topic — default channel sales-leads.
 *
 * Designed to surface the highest-intent moments to the team in real
 * time: company + ICP + agent + recording + a one-click jump back into
 * The Frame's prospect page so the rep can immediately follow up.
 */
import { postSlack, type SlackBlock } from "./client";

export interface PhoneBurnerInterestedNotification {
  companyId: string;
  companyName: string | null;
  /** Phone dialed, in whatever format the PB payload provided */
  phone: string | null;
  /** Disposition label that triggered the notification (e.g. "Set Appointment") */
  disposition: string;
  /** Agent's email/username from PB */
  agentEmail: string | null;
  /** Call duration in seconds */
  durationSeconds: number | null;
  connected: boolean;
  recordingUrl: string | null;
  notes: string | null;
  industry: string | null;
  icpTier: string | null;
  icpScore: string | number | null;
  website: string | null;
  description: string | null;
  /** Lead source if known */
  leadSource: string | null;
  /** PB's internal contact ID */
  pbContactId: string | null;
  /** Social handles to display compactly */
  socials: {
    instagram?: string | null;
    facebook?: string | null;
    tiktok?: string | null;
  };
  /** Optional reference to the call_id for future deep linking */
  callId: string | null;
  /** Public app base URL — defaults to env */
  appBaseUrl?: string;
}

const APP_BASE_URL =
  process.env.SHOPIFY_APP_URL ||
  process.env.APP_BASE_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "https://theframe.getjaxy.com";

const PB_BASE_URL = "https://www.phoneburner.com";

function fmtDuration(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return "";
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}m${sec.toString().padStart(2, "0")}s`;
}

function fmtPhone(p: string | null | undefined): string {
  if (!p) return "—";
  const digits = p.replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return p;
}

function stripUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export async function notifyPhoneBurnerInterested(
  opts: PhoneBurnerInterestedNotification,
): Promise<void> {
  const base = (opts.appBaseUrl ?? APP_BASE_URL).replace(/\/$/, "");
  const frameLink = `${base}/prospects/${opts.companyId}`;
  const pbLink = opts.pbContactId
    ? `${PB_BASE_URL}/cm/detail?cid=${opts.pbContactId}#contact/${opts.pbContactId}`
    : null;

  const companyDisplay = opts.companyName ?? "(unknown company)";
  const phoneDisplay = fmtPhone(opts.phone);
  const durationLine = opts.durationSeconds != null
    ? `${opts.connected ? "✓ Connected" : "✗ Not connected"} · ${fmtDuration(opts.durationSeconds)}`
    : opts.connected ? "✓ Connected" : "";

  // Per Daniel 2026-06-18: skip Agent + Industry/ICP rows in the
  // Slack ping — already visible inside The Frame when the rep clicks
  // through. Keep the message tight: phone, call outcome, website,
  // source.
  const fields: { type: "mrkdwn"; text: string }[] = [];
  if (opts.phone) fields.push({ type: "mrkdwn", text: `*Phone*\n${phoneDisplay}` });
  if (durationLine) {
    fields.push({ type: "mrkdwn", text: `*Call*\n${durationLine}` });
  }
  if (opts.website) {
    fields.push({
      type: "mrkdwn",
      text: `*Website*\n<${opts.website}|${stripUrl(opts.website)}>`,
    });
  }
  if (opts.leadSource) {
    fields.push({ type: "mrkdwn", text: `*Source*\n${opts.leadSource}` });
  }

  const socialPills: string[] = [];
  if (opts.socials.instagram) socialPills.push(`<${opts.socials.instagram}|IG>`);
  if (opts.socials.facebook) socialPills.push(`<${opts.socials.facebook}|FB>`);
  if (opts.socials.tiktok) socialPills.push(`<${opts.socials.tiktok}|TikTok>`);

  const linkPills: string[] = [`<${frameLink}|🔗 Open in The Frame>`];
  if (pbLink) linkPills.push(`<${pbLink}|☎️ PhoneBurner contact>`);
  if (opts.recordingUrl) linkPills.push(`<${opts.recordingUrl}|▶️ Listen to recording>`);

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🎯 *Interested lead from PhoneBurner* — *${companyDisplay}* just hit "${opts.disposition}"`,
      },
    },
  ];
  if (fields.length > 0) {
    blocks.push({ type: "section", fields });
  }

  if (opts.notes) {
    const trimmed = opts.notes.trim().slice(0, 600);
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*📝 Call note*\n>${trimmed.replace(/\n/g, "\n>")}`,
      },
    });
  }

  if (opts.description) {
    const desc = opts.description.trim().slice(0, 400);
    if (desc) {
      blocks.push({
        type: "context",
        elements: [
          { type: "mrkdwn", text: `_${desc}_` },
        ],
      });
    }
  }

  blocks.push({
    type: "context",
    elements: [
      { type: "mrkdwn", text: linkPills.join("   ·   ") },
    ],
  });

  if (socialPills.length > 0) {
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Socials: ${socialPills.join(" · ")}` },
      ],
    });
  }

  const text = `🎯 Interested lead — ${companyDisplay} (${opts.disposition})`;

  try {
    await postSlack({
      topic: "sales.phoneburner_interested",
      text,
      blocks,
    });
  } catch (e) {
    console.error("[phoneburner-interested] Slack post failed:", e);
  }
}
