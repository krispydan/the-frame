/**
 * Suppress a converted lead everywhere we might still contact them.
 *
 * When someone places a Shopify order, they're a customer — not a
 * prospect. Christina & Sandra should not dial them and Instantly
 * should not email them. This module is the single "flip everything
 * off" primitive; call it from any place we detect a new conversion.
 *
 * Effects (all idempotent, best-effort per-channel):
 *   1. Frame:  companies.status = 'customer'
 *   2. PhoneBurner: for every PB contact linked to this company via
 *      campaign_leads.phoneburner_contact_id, clear category_id so
 *      the contact drops out of every dial folder.
 *   3. Instantly: addToBlocklist(email) for every contact email on
 *      the company (blocklist is the terminal "no further email"
 *      signal — applies across every campaign).
 *   4. campaign_leads: mark local rows for these emails as
 *      'unsubscribed' so the Frame outreach UI reflects reality.
 *
 * Best-effort by design — never throws to the caller. Each channel's
 * failure is logged + reported in the returned summary; other
 * channels keep running.
 */

import { sqlite } from "@/lib/db";
import { phoneBurnerClient } from "@/modules/sales/lib/phoneburner-client";
import { instantlyClient } from "@/modules/sales/lib/instantly-client";

export interface SuppressResult {
  companyId: string;
  frameFlipped: boolean;
  emails: string[];
  pbContactsCleared: number;
  pbErrors: string[];
  instantlyBlocklisted: number;
  instantlyErrors: string[];
  campaignLeadsMarked: number;
}

export async function suppressLeadOnConversion(
  companyId: string,
  buyerEmail: string | null,
): Promise<SuppressResult> {
  const result: SuppressResult = {
    companyId,
    frameFlipped: false,
    emails: [],
    pbContactsCleared: 0,
    pbErrors: [],
    instantlyBlocklisted: 0,
    instantlyErrors: [],
    campaignLeadsMarked: 0,
  };

  // 1. Frame status flip
  try {
    const flip = sqlite
      .prepare(
        `UPDATE companies
            SET status = 'customer', updated_at = datetime('now')
          WHERE id = ? AND status != 'customer'`,
      )
      .run(companyId);
    result.frameFlipped = flip.changes > 0;
  } catch (e) {
    console.error("[suppress-on-conversion] frame flip failed:", e);
  }

  // 2. Collect distinct emails on this company (contacts table) + buyer
  const contactEmails = sqlite
    .prepare(
      `SELECT DISTINCT lower(TRIM(email)) AS email
         FROM contacts
        WHERE company_id = ?
          AND email IS NOT NULL AND TRIM(email) != ''`,
    )
    .all(companyId) as Array<{ email: string }>;
  const emailSet = new Set<string>();
  for (const r of contactEmails) if (r.email) emailSet.add(r.email);
  if (buyerEmail) emailSet.add(buyerEmail.toLowerCase().trim());
  result.emails = [...emailSet].filter(Boolean);

  // 3. PhoneBurner — clear category_id on every linked PB contact
  const pbRows = sqlite
    .prepare(
      `SELECT DISTINCT phoneburner_contact_id
         FROM campaign_leads
        WHERE company_id = ? AND phoneburner_contact_id IS NOT NULL`,
    )
    .all(companyId) as Array<{ phoneburner_contact_id: string }>;
  for (const r of pbRows) {
    try {
      await phoneBurnerClient.updateContact(r.phoneburner_contact_id, {
        category_id: undefined,
      });
      result.pbContactsCleared++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.pbErrors.push(`${r.phoneburner_contact_id}: ${msg.slice(0, 200)}`);
    }
  }

  // 4. Instantly — blocklist each email (terminal, applies across all campaigns)
  //    + mark local campaign_leads as unsubscribed so the Frame UI reflects it.
  const markLocal = sqlite.prepare(
    `UPDATE campaign_leads
        SET status = 'unsubscribed', updated_at = datetime('now')
      WHERE lower(TRIM(email)) = ?
        AND status NOT IN ('bounced','unsubscribed')`,
  );
  for (const email of result.emails) {
    try {
      await instantlyClient.addToBlocklist(email);
      result.instantlyBlocklisted++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 409/already-blocked is fine — treat as success.
      if (/already|exists|409|duplicate/i.test(msg)) {
        result.instantlyBlocklisted++;
      } else {
        result.instantlyErrors.push(`${email}: ${msg.slice(0, 200)}`);
      }
    }
    try {
      const upd = markLocal.run(email);
      result.campaignLeadsMarked += upd.changes;
    } catch (e) {
      console.error("[suppress-on-conversion] mark local failed:", e);
    }
  }

  return result;
}
