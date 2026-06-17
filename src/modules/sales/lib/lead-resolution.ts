/**
 * Resolve an inbound integration event (Instantly webhook,
 * PhoneBurner call log) back to one of our CRM entities — a specific
 * campaign_lead row when possible, and always a company_id when we
 * can find one.
 *
 * Used by:
 *   - src/modules/sales/lib/instantly-webhooks.ts (resolve by email)
 *   - src/modules/sales/lib/phoneburner-sync.ts  (resolve by our
 *     internal id round-tripped through PB's user_id field, then by
 *     phone digits as fallback)
 *
 * Returns null only when no match is found — that's a normal outcome
 * (agents add leads in the integration UI that we never imported)
 * and the caller should log it without retrying.
 */
import { sqlite } from "@/lib/db";

export interface ResolveResult {
  companyId: string;
  campaignLeadId: string | null;
}

/**
 * Resolve by email + optional Instantly campaign id. Strongest match
 * is a campaign_leads row with the same email under the same Instantly
 * campaign; falls back to email-only matches, then contacts, then
 * companies.
 */
export function resolveByEmail(opts: {
  leadEmail: string | null;
  instantlyCampaignId?: string | null;
}): ResolveResult | null {
  const { leadEmail, instantlyCampaignId } = opts;
  if (!leadEmail) return null;
  const email = leadEmail.trim().toLowerCase();
  if (!email) return null;

  if (instantlyCampaignId) {
    const row = sqlite
      .prepare(
        `SELECT cl.id, cl.company_id
           FROM campaign_leads cl
           JOIN campaigns c ON c.id = cl.campaign_id
          WHERE c.instantly_campaign_id = ?
            AND lower(cl.email) = ?
          LIMIT 1`,
      )
      .get(instantlyCampaignId, email) as
      | { id: string; company_id: string }
      | undefined;
    if (row) return { companyId: row.company_id, campaignLeadId: row.id };
  }

  const clRow = sqlite
    .prepare(
      `SELECT id, company_id FROM campaign_leads
        WHERE lower(email) = ? AND company_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(email) as { id: string; company_id: string } | undefined;
  if (clRow) return { companyId: clRow.company_id, campaignLeadId: clRow.id };

  const contactRow = sqlite
    .prepare(
      `SELECT company_id FROM contacts
        WHERE lower(email) = ? AND company_id IS NOT NULL
        LIMIT 1`,
    )
    .get(email) as { company_id: string } | undefined;
  if (contactRow) {
    return { companyId: contactRow.company_id, campaignLeadId: null };
  }

  const compRow = sqlite
    .prepare(`SELECT id FROM companies WHERE lower(email) = ? LIMIT 1`)
    .get(email) as { id: string } | undefined;
  if (compRow) return { companyId: compRow.id, campaignLeadId: null };

  return null;
}

/**
 * Resolve by our internal campaign_lead.id (round-tripped through
 * PhoneBurner's `user_id` field on the contact record). This is the
 * cleanest match for PB call events because PB carries the id we
 * gave them on every callback.
 */
export function resolveByCampaignLeadId(campaignLeadId: string | null): ResolveResult | null {
  if (!campaignLeadId) return null;
  const row = sqlite
    .prepare("SELECT id, company_id FROM campaign_leads WHERE id = ? LIMIT 1")
    .get(campaignLeadId) as { id: string; company_id: string } | undefined;
  if (!row) return null;
  return { companyId: row.company_id, campaignLeadId: row.id };
}

/**
 * Resolve by PhoneBurner contact id. Used when the user_id round-trip
 * came back empty (e.g. the contact was manually added in PB outside
 * our push flow but we later stamped phoneburner_contact_id manually).
 */
export function resolveByPbContactId(pbContactId: string | null): ResolveResult | null {
  if (!pbContactId) return null;
  const row = sqlite
    .prepare(
      `SELECT id, company_id FROM campaign_leads
        WHERE phoneburner_contact_id = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(pbContactId) as { id: string; company_id: string } | undefined;
  if (!row) return null;
  return { companyId: row.company_id, campaignLeadId: row.id };
}

/**
 * Last-resort phone-based resolution. Strips to 10 US digits and
 * searches company_phones, then companies.phone.
 */
export function resolveByPhone(phoneRaw: string | null | undefined): ResolveResult | null {
  if (!phoneRaw) return null;
  const digits = phoneRaw.replace(/\D+/g, "");
  // Try exact, then strip leading 1.
  const candidates = new Set<string>();
  candidates.add(digits);
  if (digits.length === 11 && digits.startsWith("1")) candidates.add(digits.slice(1));
  if (digits.length === 10) candidates.add(`1${digits}`);

  for (const candidate of candidates) {
    if (!candidate) continue;
    const phoneRow = sqlite
      .prepare(
        `SELECT company_id FROM company_phones
          WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(',''),')','') = ?
          LIMIT 1`,
      )
      .get(candidate) as { company_id: string } | undefined;
    if (phoneRow) {
      return { companyId: phoneRow.company_id, campaignLeadId: null };
    }

    const compRow = sqlite
      .prepare(
        `SELECT id FROM companies
          WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(',''),')','') = ?
          LIMIT 1`,
      )
      .get(candidate) as { id: string } | undefined;
    if (compRow) return { companyId: compRow.id, campaignLeadId: null };
  }
  return null;
}
