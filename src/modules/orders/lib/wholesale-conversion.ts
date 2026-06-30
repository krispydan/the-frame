/**
 * Lead → wholesale-customer conversion detection.
 *
 * Fired (best-effort) when a wholesale/Faire order is created. If the buying
 * company was a worked prospect (we'd emailed/called them), it's a conversion
 * — celebrate it (Slack + email, Overjoy-style). If instead a brand-new
 * customer fuzzy-matches an existing worked prospect under a different record,
 * flag it so the team can review/merge. Gated to the first order so repeat
 * wholesale orders don't re-alert; idempotent per order.
 */

import { sqlite } from "@/lib/db";

function money(amount: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `$${Math.round(amount)}`;
  }
}

function getSetting(key: string): string | null {
  const r = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string | null } | undefined;
  return r?.value ?? null;
}

/** Normalize a company name for fuzzy comparison (drop suffixes/punct/words). */
function normName(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s]/g, " ")
    .replace(/\b(llc|inc|ltd|co|corp|company|the|boutique|store|shop|llp)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface OrderRow {
  id: string;
  company_id: string | null;
  channel: string;
  status: string;
  total: number;
  currency: string | null;
  order_number: string | null;
}

export async function detectWholesaleConversion(orderId: string): Promise<void> {
  const order = sqlite
    .prepare("SELECT id, company_id, channel, status, total, currency, order_number FROM orders WHERE id = ?")
    .get(orderId) as OrderRow | undefined;
  if (!order || !order.company_id) return;
  if (!/wholesale|faire/i.test(order.channel)) return;

  const company = sqlite.prepare("SELECT id, name, state FROM companies WHERE id = ?").get(order.company_id) as
    | { id: string; name: string | null; state: string | null }
    | undefined;
  if (!company) return;

  // Only the first order is a conversion moment.
  const cnt = (sqlite
    .prepare("SELECT COUNT(*) n FROM orders WHERE company_id = ? AND status != 'cancelled'")
    .get(order.company_id) as { n: number }).n;
  if (cnt > 1) return;

  // Worked-prospect signal: any campaign_leads for this company.
  const cl = sqlite
    .prepare(
      `SELECT
         MIN(COALESCE(sent_at, created_at)) AS first_at,
         (SELECT email FROM campaign_leads WHERE company_id = ? AND TRIM(COALESCE(email,'')) <> ''
            ORDER BY COALESCE(sent_at, created_at) ASC LIMIT 1) AS email
       FROM campaign_leads WHERE company_id = ?`,
    )
    .get(order.company_id, order.company_id) as { first_at: string | null; email: string | null } | undefined;
  const wasWorked = !!cl?.first_at;

  // Fuzzy duplicate: a DIFFERENT worked prospect with the same normalized name.
  let duplicate: { id: string; name: string } | null = null;
  if (!wasWorked) {
    const norm = normName(company.name);
    const token = norm.split(" ")[0] || "";
    if (norm.length >= 4 && token.length >= 3) {
      const cands = sqlite
        .prepare(
          `SELECT c.id, c.name FROM companies c
             WHERE c.id != ? AND LOWER(COALESCE(c.name,'')) LIKE ?
               AND EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.company_id = c.id)
             LIMIT 25`,
        )
        .all(company.id, `%${token}%`) as Array<{ id: string; name: string | null }>;
      for (const cand of cands) {
        if (normName(cand.name) === norm) {
          duplicate = { id: cand.id, name: cand.name || "Prospect" };
          break;
        }
      }
    }
  }

  if (!wasWorked && !duplicate) return;

  // Idempotency: one alert per order.
  const changed = sqlite
    .prepare(
      `INSERT OR IGNORE INTO lead_conversion_alerts (order_id, company_id, matched_company_id, kind)
       VALUES (?, ?, ?, ?)`,
    )
    .run(order.id, order.company_id, duplicate?.id ?? null, wasWorked ? "converted" : "fuzzy_dup").changes;
  if (!changed) return;

  const base = (process.env.SHOPIFY_APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  const prospectUrl = base ? `${base}/prospects/${order.company_id}` : null;
  const dupUrl = duplicate && base ? `${base}/prospects/${duplicate.id}` : null;
  const recipient = getSetting("lead_conversion_alert_email") || process.env.CONVERSION_ALERT_EMAIL || "daniel@getjaxy.com";

  try {
    const { notifyLeadConverted } = await import("@/modules/integrations/lib/slack/notifications");
    await notifyLeadConverted({
      companyName: company.name,
      prospectUrl,
      contactEmail: cl?.email ?? null,
      firstContactAt: cl?.first_at ?? null,
      orderTotal: order.total,
      currency: order.currency || "USD",
      channel: order.channel,
      isFirstOrder: true,
      duplicate: duplicate ? { name: duplicate.name, url: dupUrl } : null,
    });
  } catch (e) {
    console.error("[wholesale-conversion] slack alert failed:", e);
  }

  try {
    const { sendLeadConvertedEmail } = await import("@/lib/email");
    await sendLeadConvertedEmail(recipient, {
      companyName: company.name || "A store",
      contactEmail: cl?.email ?? null,
      firstContactAt: cl?.first_at ?? null,
      orderTotal: money(order.total, order.currency || "USD"),
      isFirstOrder: true,
      channel: order.channel,
      prospectUrl,
      duplicate: duplicate ? { name: duplicate.name, url: dupUrl } : null,
    });
  } catch (e) {
    console.error("[wholesale-conversion] email failed:", e);
  }
}
