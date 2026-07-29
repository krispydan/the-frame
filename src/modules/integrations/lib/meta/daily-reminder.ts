/**
 * Daily "download and upload today's Meta leads" reminder.
 *
 * While `leads_retrieval` sits in App Review the leadgen webhook can't fire, so
 * a Facebook lead only reaches the frame when someone downloads the export and
 * uploads it. A lead that sits in Meta's forms library for a week is a lead a
 * competitor answered first — hence a nudge every morning rather than trusting
 * anyone to remember.
 *
 * The email is written to make itself obsolete. It reports what actually
 * happened yesterday, and the moment the webhook starts delivering it says so
 * and tells you to turn the job off, instead of nagging forever about a manual
 * step that's no longer needed.
 */

import { sqlite } from "@/lib/db";
import { sendMetaLeadImportReminderEmail } from "@/lib/email";
import { metaLeadsConfigured } from "./client";

export interface ReminderStats {
  /** Leads that arrived via the real-time webhook in the last 24h. */
  webhookLeads24h: number;
  /** Leads that arrived via a manual CSV upload in the last 24h. */
  csvLeads24h: number;
  /** Leads uploaded in the last 7 days — is anyone actually doing this? */
  csvLeads7d: number;
  /** Verified webhook deliveries in the last 24h (proof Meta is calling us). */
  deliveries24h: number;
  /** Days since the last CSV upload, null if there's never been one. */
  daysSinceLastImport: number | null;
  /** Leads sitting unprocessed — a signal something is wrong downstream. */
  pending: number;
  errored: number;
}

function num(sql: string, ...args: unknown[]): number {
  try {
    const r = sqlite.prepare(sql).get(...args) as Record<string, unknown> | undefined;
    const v = r ? Object.values(r)[0] : 0;
    return typeof v === "number" ? v : 0;
  } catch {
    return 0;
  }
}

export function reminderStats(): ReminderStats {
  const lastImport = (() => {
    try {
      return (
        sqlite
          .prepare("SELECT created_at FROM meta_leads WHERE source = 'csv' ORDER BY created_at DESC LIMIT 1")
          .get() as { created_at: string } | undefined
      )?.created_at ?? null;
    } catch {
      return null;
    }
  })();

  return {
    webhookLeads24h: num(
      "SELECT COUNT(*) v FROM meta_leads WHERE COALESCE(source,'webhook') = 'webhook' AND created_at >= datetime('now','-1 day')",
    ),
    csvLeads24h: num("SELECT COUNT(*) v FROM meta_leads WHERE source = 'csv' AND created_at >= datetime('now','-1 day')"),
    csvLeads7d: num("SELECT COUNT(*) v FROM meta_leads WHERE source = 'csv' AND created_at >= datetime('now','-7 days')"),
    deliveries24h: num(
      "SELECT COUNT(*) v FROM meta_webhook_events WHERE signature_valid = 1 AND leadgen_ids IS NOT NULL AND received_at >= datetime('now','-1 day')",
    ),
    daysSinceLastImport: lastImport
      ? num("SELECT CAST(julianday('now') - julianday(?) AS INTEGER) v", lastImport)
      : null,
    pending: num("SELECT COUNT(*) v FROM meta_leads WHERE status = 'received'"),
    errored: num("SELECT COUNT(*) v FROM meta_leads WHERE status = 'error'"),
  };
}

/**
 * Cron handler. Sends unless the webhook has clearly taken over — in which case
 * it sends one final "you can stop doing this" note, then goes quiet.
 */
export async function runMetaLeadCsvReminder(): Promise<Record<string, unknown>> {
  const recipient = process.env.META_LEADS_EMAIL || process.env.FAIRE_EXPORT_EMAIL || "daniel@getjaxy.com";
  const stats = reminderStats();

  // The webhook is live once Meta has delivered real leadgen payloads AND the
  // resulting leads are landing. Two consecutive quiet days of manual uploads
  // isn't enough to conclude that — deliveries are the proof.
  const webhookLive = stats.deliveries24h > 0 && stats.webhookLeads24h > 0;

  // Once it's live we announce it once, then stop. The flag stops the daily
  // "you can turn this off" note from itself becoming a daily nag.
  const announced =
    (sqlite.prepare("SELECT value FROM settings WHERE key = 'meta_webhook_live_announced'").get() as
      | { value: string | null }
      | undefined)?.value === "1";

  if (webhookLive && announced) {
    return { ok: true, sent: false, skipped: "webhook is live and already announced", stats };
  }

  const base = (process.env.SHOPIFY_APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  const r = await sendMetaLeadImportReminderEmail(recipient, {
    ...stats,
    webhookLive,
    uploadUrl: base ? `${base}/prospects/facebook-leads` : null,
    configured: metaLeadsConfigured(),
  });

  if (r.ok && webhookLive) {
    sqlite
      .prepare(
        `INSERT INTO settings (key, value, type, module, updated_at)
         VALUES ('meta_webhook_live_announced', '1', 'string', 'integrations', datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now')`,
      )
      .run();
  }

  return { ok: r.ok, sent: r.ok, recipient, webhookLive, stats };
}
