/**
 * Push an explicit set of companies into a campaign, and ship them to Instantly.
 *
 * Extracted from the v1 push-by-ids route so ops tooling and the UI share one
 * implementation — AGENTS.md, "one implementation, two front doors". The rules
 * below are the originals; the only change is that they now live somewhere both
 * doors can reach.
 *
 * The gates, and what each one is protecting:
 *
 *   verified valid/catchall   sending to an address we have not checked, or have
 *                             checked and found bad, damages the sending domain
 *                             for every other lead in the campaign
 *   not already in this campaign   duplicate membership double-sends
 *   this ADDRESS not already mailed anywhere   duplicate company rows for one
 *                             shop are common after imports, and a mailbox does
 *                             not care which row we mailed it from
 *
 * That last check deliberately no longer requires an instantly_lead_id. Keying
 * on it was what let 385 already-contacted shops look fresh: campaigns run
 * directly in Instantly never send an id back, so the absence of one says
 * nothing about whether we mailed someone.
 */

import { randomUUID } from "crypto";
import { sqlite } from "@/lib/db";
import { handleSyncRequest } from "./instantly-sync";

const PRIMARY_EMAIL_SUBQ = `(
  SELECT ct.email FROM contacts ct
  WHERE ct.company_id = c.id AND TRIM(COALESCE(ct.email,'')) <> ''
  ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1
)`;

export interface PushResult {
  ok: boolean;
  campaign: { id: string; name: string; instantlyCampaignId: string | null };
  requested: number;
  eligible: number;
  inserted: number;
  /**
   * Why each requested company did NOT go out. `notDeliverable` covers
   * addresses NeverBounce checked and returned unknown/invalid/disposable for —
   * they are verified, just not safe to send to. It was previously called
   * "unverified", which read as "we never checked" and understated the point.
   */
  rejected: { notDeliverable: number; neverChecked: number; alreadyInCampaign: number; alreadyMailed: number; noEmail: number };
  preview?: Array<{ id: string; name: string; email: string }>;
  instantly?: unknown;
  error?: string;
}

export async function pushCompaniesToCampaign(opts: {
  campaignId: string;
  companyIds: string[];
  dryRun?: boolean;
  /** Insert the lead rows but do not trigger the Instantly sync. */
  skipSync?: boolean;
}): Promise<PushResult> {
  const ids = [...new Set(opts.companyIds)].slice(0, 5000);

  const campaign = sqlite
    .prepare("SELECT id, name, instantly_campaign_id FROM campaigns WHERE id = ? LIMIT 1")
    .get(opts.campaignId) as { id: string; name: string; instantly_campaign_id: string | null } | undefined;

  if (!campaign) throw new Error("campaign not found");
  if (!campaign.instantly_campaign_id) throw new Error("campaign is not linked to an Instantly campaign");

  const camp = { id: campaign.id, name: campaign.name, instantlyCampaignId: campaign.instantly_campaign_id };
  const ph = ids.map(() => "?").join(",");

  // Diagnose every rejection rather than only counting survivors: "we pushed 12
  // of 163" is unactionable without knowing which gate stopped the other 151.
  const audit = sqlite
    .prepare(
      `SELECT c.id,
              ${PRIMARY_EMAIL_SUBQ} AS email,
              c.email_verification_status AS ver,
              EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.campaign_id = ? AND cl.company_id = c.id) AS inCamp
         FROM companies c WHERE c.id IN (${ph})`,
    )
    .all(campaign.id, ...ids) as Array<{ id: string; email: string | null; ver: string | null; inCamp: number }>;

  const mailed = new Set(
    (sqlite
      .prepare("SELECT DISTINCT LOWER(TRIM(email)) e FROM campaign_leads WHERE email IS NOT NULL AND TRIM(email) <> ''")
      .all() as Array<{ e: string }>).map((r) => r.e),
  );

  const rejected = { notDeliverable: 0, neverChecked: 0, alreadyInCampaign: 0, alreadyMailed: 0, noEmail: 0 };
  const eligible: Array<{ id: string; name: string; email: string }> = [];
  const nameOf = new Map(
    (sqlite.prepare(`SELECT id, name FROM companies WHERE id IN (${ph})`).all(...ids) as Array<{ id: string; name: string }>)
      .map((r) => [r.id, r.name]),
  );

  for (const r of audit) {
    const email = (r.email || "").trim().toLowerCase();
    if (!email) { rejected.noEmail++; continue; }
    if (!["valid", "catchall"].includes(String(r.ver))) {
      if (r.ver) rejected.notDeliverable++; else rejected.neverChecked++;
      continue;
    }
    if (r.inCamp) { rejected.alreadyInCampaign++; continue; }
    if (mailed.has(email)) { rejected.alreadyMailed++; continue; }
    eligible.push({ id: r.id, name: nameOf.get(r.id) ?? "", email });
  }

  if (opts.dryRun) {
    return { ok: true, campaign: camp, requested: ids.length, eligible: eligible.length, inserted: 0, rejected, preview: eligible.slice(0, 20) };
  }

  const insert = sqlite.prepare(
    `INSERT OR IGNORE INTO campaign_leads (id, campaign_id, company_id, contact_id, email, status, created_at)
     VALUES (?, ?, ?, NULL, ?, 'queued', datetime('now'))`,
  );
  let inserted = 0;
  sqlite.transaction(() => {
    for (const c of eligible) {
      if (insert.run(randomUUID(), campaign.id, c.id, c.email).changes > 0) inserted++;
    }
  })();

  if (opts.skipSync) {
    return { ok: true, campaign: camp, requested: ids.length, eligible: eligible.length, inserted, rejected };
  }

  try {
    const instantly = await handleSyncRequest();
    return { ok: true, campaign: camp, requested: ids.length, eligible: eligible.length, inserted, rejected, instantly };
  } catch (e) {
    // The rows ARE inserted; say so plainly. A caller who reads this as a total
    // failure and retries would double-queue.
    return {
      ok: false, campaign: camp, requested: ids.length, eligible: eligible.length, inserted, rejected,
      error: `lead rows inserted (${inserted}) but the Instantly sync failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
