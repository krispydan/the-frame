/**
 * Backfill "we already contacted this shop" from an Instantly CSV export.
 *
 * Why this is needed: importLeadsFromInstantly() only pulls campaigns that
 * already exist in `campaigns` WITH an instantly_campaign_id. The AJM campaigns
 * were run in Instantly without ever being registered here, so the frame has no
 * record of ~1,590 contacted leads — and the cohort builder duly offered 385 of
 * them up to be mailed a second time.
 *
 * What gets written, and why each one prevents a specific mistake:
 *
 *   campaign_leads row     the durable "already in a campaign" marker. Without
 *                          it every future cohort re-offers these leads.
 *   verification status    the export already knows which addresses are good.
 *                          Copying that across saves paying NeverBounce to
 *                          re-learn it, and BOUNCED becomes 'invalid' so a
 *                          known-dead address can never be mailed again.
 *   do_not_contact         for anyone who replied "not interested". They told
 *                          us once; the system should not need telling twice.
 *
 * Matching is by email against contacts, which is where email is canonical.
 * Unmatched rows are REPORTED, not invented as new companies: a contacted
 * address we cannot tie to a company is a data-quality finding, and silently
 * creating shell companies would bury it.
 */

import { randomUUID } from "crypto";
import { sqlite } from "@/lib/db";

export interface ContactedRow {
  email: string;
  campaign?: string;
  leadStatus?: string;
  interest?: string;
  verification?: string;
  company?: string;
}

export interface BackfillResult {
  received: number;
  matchedCompanies: number;
  unmatched: number;
  campaignsCreated: number;
  leadRowsCreated: number;
  leadRowsAlreadyPresent: number;
  verificationWritten: Record<string, number>;
  markedDoNotContact: number;
  interestCounts: Record<string, number>;
  unmatchedSample: string[];
}

/** Instantly's lead status → our LEAD_STATUSES enum. */
function mapStatus(leadStatus = "", interest = ""): "sent" | "replied" | "bounced" | "unsubscribed" {
  const s = leadStatus.toLowerCase();
  if (s.includes("bounce")) return "bounced";
  if (s.includes("reply") || interest.toLowerCase() === "interested" || interest.toLowerCase() === "won") return "replied";
  return "sent";
}

/**
 * Instantly's verification label → NeverBounce vocabulary, which is what
 * companies.email_verification_status already speaks. A bounce is harder
 * evidence than any pre-send check, so it wins over a "Verified" label.
 */
function mapVerification(verification = "", leadStatus = ""): string | null {
  if (leadStatus.toLowerCase().includes("bounce")) return "invalid";
  const v = verification.trim().toLowerCase();
  if (v === "verified") return "valid";
  if (v === "invalid") return "invalid";
  return null;
}

export function backfillContacted(rows: ContactedRow[], dryRun = false): BackfillResult {
  const res: BackfillResult = {
    received: rows.length, matchedCompanies: 0, unmatched: 0, campaignsCreated: 0,
    leadRowsCreated: 0, leadRowsAlreadyPresent: 0, verificationWritten: {},
    markedDoNotContact: 0, interestCounts: {}, unmatchedSample: [],
  };

  const findCompany = sqlite.prepare(
    `SELECT c.id AS companyId, ct.id AS contactId
       FROM contacts ct JOIN companies c ON c.id = ct.company_id
      WHERE LOWER(TRIM(ct.email)) = ? LIMIT 1`,
  );
  const findCampaign = sqlite.prepare("SELECT id FROM campaigns WHERE name = ? LIMIT 1");
  const insertCampaign = sqlite.prepare(
    `INSERT INTO campaigns (id, name, type, status, description, created_at, updated_at)
     VALUES (?, ?, 'email_sequence', 'completed', 'Backfilled from an Instantly CSV export', datetime('now'), datetime('now'))`,
  );
  const findLink = sqlite.prepare(
    "SELECT id FROM campaign_leads WHERE campaign_id = ? AND company_id = ? LIMIT 1",
  );
  const insertLink = sqlite.prepare(
    `INSERT INTO campaign_leads (id, campaign_id, company_id, contact_id, email, status, sent_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  );
  const setVerification = sqlite.prepare(
    `UPDATE companies SET email_verification_status = ?, email_verified_at = datetime('now') WHERE id = ?`,
  );
  const setDnc = sqlite.prepare(
    `UPDATE companies SET do_not_contact = 1, disqualify_reason = COALESCE(disqualify_reason, ?) WHERE id = ?`,
  );

  const campaignIds = new Map<string, string>();

  const run = sqlite.transaction(() => {
    for (const r of rows) {
      const email = (r.email || "").trim().toLowerCase();
      if (!email.includes("@")) continue;

      res.interestCounts[r.interest || "—"] = (res.interestCounts[r.interest || "—"] ?? 0) + 1;

      const hit = findCompany.get(email) as { companyId: string; contactId: string } | undefined;
      if (!hit) {
        res.unmatched++;
        if (res.unmatchedSample.length < 25) res.unmatchedSample.push(email);
        continue;
      }
      res.matchedCompanies++;
      if (dryRun) continue;

      const campName = r.campaign?.trim() || "AJM - Instantly (backfilled)";
      let campId = campaignIds.get(campName);
      if (!campId) {
        const existing = findCampaign.get(campName) as { id: string } | undefined;
        if (existing) campId = existing.id;
        else {
          campId = randomUUID();
          insertCampaign.run(campId, campName);
          res.campaignsCreated++;
        }
        campaignIds.set(campName, campId);
      }

      if (findLink.get(campId, hit.companyId)) {
        res.leadRowsAlreadyPresent++;
      } else {
        insertLink.run(randomUUID(), campId, hit.companyId, hit.contactId, email,
          mapStatus(r.leadStatus, r.interest));
        res.leadRowsCreated++;
      }

      const verdict = mapVerification(r.verification, r.leadStatus);
      if (verdict) {
        setVerification.run(verdict, hit.companyId);
        res.verificationWritten[verdict] = (res.verificationWritten[verdict] ?? 0) + 1;
      }

      if ((r.interest || "").toLowerCase() === "not interested") {
        setDnc.run("replied 'not interested' to an AJM Instantly campaign", hit.companyId);
        res.markedDoNotContact++;
      }
    }
  });
  run();

  return res;
}
