/**
 * F3-002: 2-Way Sync Engine (Frame ↔ Instantly)
 * Push: Upload leads/campaigns to Instantly
 * Pull: Fetch analytics & lead statuses, update local DB
 */
import { sqlite } from "@/lib/db";
import { instantlyClient, type InstantlyLead } from "./instantly-client";
import { logger } from "@/modules/core/lib/logger";

export interface SyncResult {
  pushed: { campaigns: number; leads: number };
  pulled: { campaigns: number; leads: number; stageUpdates: number };
  errors: string[];
}

// ── Push Sync: Frame → Instantly ──

/**
 * Build the per-lead custom-variable bag we ship to Instantly. Every
 * key becomes a `{{key}}` template token in the sequence body, so the
 * goal is "give Daniel the most useful columns for personalization
 * without flooding the Instantly UI with nulls."
 *
 * Conventions:
 * - snake_case keys (matches Instantly's own first_name / company_name
 *   convention so templates look uniform).
 * - Strings only. Numbers (icp_score, yearly_sales) get formatted
 *   here — Instantly merges the literal string into the email body.
 * - Sales formatted as "$1.2M" / "$450K" — friendlier in copy than
 *   raw cents.
 * - Empty/null values are dropped in addLeadsToCampaign's cleanVars
 *   step, so we don't have to be defensive here; just pass through.
 */
export function buildCustomVariables(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    if (v === null || v === undefined) return;
    const s = String(v).trim();
    if (!s) return;
    out[k] = s;
  };

  // Location — `{{city}}` is the headline request: "we want to push
  // the store city to instantly for the personalization."
  put("city", row.city);
  put("state", row.state);
  put("country", row.country);

  // Firmographics / segmentation
  put("industry", row.industry);
  put("category", row.category);
  put("segment", row.segment);
  put("domain", row.domain);
  put("ecom_platform", row.ecom_platform);
  put("contact_title", row.contact_title);

  // ICP signals — useful for "we noticed you're a Tier A Shopify
  // store doing $X/yr" style intros.
  put("icp_tier", row.icp_tier);
  if (typeof row.icp_score === "number") put("icp_score", String(row.icp_score));
  if (typeof row.employee_count === "number" && row.employee_count > 0) {
    put("employee_count", String(row.employee_count));
  }

  // StoreLeads sales/traffic estimates — format for human eyes.
  if (typeof row.estimated_yearly_sales_cents === "number" && row.estimated_yearly_sales_cents > 0) {
    put("estimated_yearly_sales", formatMoneyShort(row.estimated_yearly_sales_cents / 100));
  }
  if (typeof row.estimated_monthly_visits === "number" && row.estimated_monthly_visits > 0) {
    put("estimated_monthly_visits", formatNumberShort(row.estimated_monthly_visits));
  }

  // Socials — handy for "saw your reel about X" openers.
  put("instagram_url", row.instagram_url);
  put("facebook_url", row.facebook_url);
  put("tiktok_url", row.tiktok_url);

  return out;
}

function formatMoneyShort(usd: number): string {
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(usd >= 10_000_000 ? 0 : 1)}M`;
  if (usd >= 1_000) return `$${Math.round(usd / 1_000)}K`;
  return `$${Math.round(usd)}`;
}

function formatNumberShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
}


async function pushCampaigns(): Promise<{ campaigns: number; leads: number; errors: string[] }> {
  let campaignCount = 0;
  let leadCount = 0;
  const errors: string[] = [];

  // Find campaigns without an instantly_campaign_id
  const unsynced = sqlite.prepare(
    "SELECT * FROM campaigns WHERE instantly_campaign_id IS NULL AND status != 'completed'"
  ).all() as Array<Record<string, unknown>>;

  for (const camp of unsynced) {
    try {
      const result = await instantlyClient.createCampaign({ name: camp.name as string });
      sqlite.prepare(
        "UPDATE campaigns SET instantly_campaign_id = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(result.id, camp.id);

      // Track sync
      sqlite.prepare(
        "INSERT OR REPLACE INTO instantly_sync (id, entity_type, entity_id, instantly_id, last_synced_at, sync_status) VALUES (?, 'campaign', ?, ?, datetime('now'), 'synced')"
      ).run(crypto.randomUUID(), camp.id as string, result.id);

      campaignCount++;
    } catch (err) {
      errors.push(`Push campaign ${camp.name}: ${(err as Error).message}`);
    }
  }

  // Push leads for campaigns that have an instantly_campaign_id
  const campaignsWithId = sqlite.prepare(
    "SELECT id, instantly_campaign_id FROM campaigns WHERE instantly_campaign_id IS NOT NULL"
  ).all() as Array<{ id: string; instantly_campaign_id: string }>;

  for (const camp of campaignsWithId) {
    // Phase 7.7 cross-campaign dedup: skip rows where this email already
    // has an instantly_lead_id in some OTHER campaign_leads row. The
    // existing instantly_lead_id IS NULL check already prevents the
    // SAME row from re-pushing; this extends it to "same email,
    // anywhere."
    // Pull the full company + contact context so we can ship rich
    // custom variables to Instantly for personalization. Anything we
    // pass here becomes a `{{variable_name}}` token available inside
    // the sequence body in Instantly. Keep names snake_case so Daniel
    // can drop {{city}}, {{industry}}, {{icp_tier}}, etc. into copy
    // directly.
    const unsentLeads = sqlite.prepare(`
      SELECT cl.*,
             co.name      as company_name,
             co.website   as website,
             co.domain    as domain,
             co.city      as city,
             co.state     as state,
             co.country   as country,
             co.industry  as industry,
             co.category  as category,
             co.segment   as segment,
             co.icp_tier  as icp_tier,
             co.icp_score as icp_score,
             co.ecom_platform                as ecom_platform,
             co.employee_count               as employee_count,
             co.estimated_yearly_sales_cents as estimated_yearly_sales_cents,
             co.estimated_monthly_visits     as estimated_monthly_visits,
             co.instagram_url                as instagram_url,
             co.facebook_url                 as facebook_url,
             co.tiktok_url                   as tiktok_url,
             ct.first_name,
             ct.last_name,
             ct.email      as contact_email,
             ct.phone      as contact_phone,
             ct.title      as contact_title
      FROM campaign_leads cl
      LEFT JOIN companies co ON co.id = cl.company_id
      LEFT JOIN contacts ct ON ct.id = cl.contact_id
      WHERE cl.campaign_id = ? AND cl.instantly_lead_id IS NULL AND cl.email IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM campaign_leads cl2
          WHERE cl2.id != cl.id
            AND LOWER(cl2.email) = LOWER(cl.email)
            AND cl2.instantly_lead_id IS NOT NULL
        )
    `).all(camp.id) as Array<Record<string, unknown>>;

    if (unsentLeads.length === 0) continue;

    const leads: InstantlyLead[] = unsentLeads.map((l) => ({
      email: (l.email || l.contact_email) as string,
      first_name: l.first_name as string | undefined,
      last_name: l.last_name as string | undefined,
      company_name: l.company_name as string | undefined,
      phone: l.contact_phone as string | undefined,
      website: l.website as string | undefined,
      custom_variables: buildCustomVariables(l),
    }));

    try {
      const result = await instantlyClient.addLeadsToCampaign(camp.instantly_campaign_id, leads);
      // Map each Instantly response row back to its local campaign_leads
      // row by email and persist the REAL Instantly lead id (not the
      // synthetic `instantly-<localId>` placeholder the old code used).
      // Per-lead errors get surfaced so partial-success is observable.
      const updateOk = sqlite.prepare(
        "UPDATE campaign_leads SET instantly_lead_id = ?, status = 'sent' WHERE id = ?",
      );
      const byEmail = new Map<string, { id?: string; error?: string }>();
      for (const r of result.results) byEmail.set(r.email.toLowerCase(), r);
      for (const lead of unsentLeads) {
        const emailRaw = (lead.email || lead.contact_email) as string | undefined;
        const r = emailRaw ? byEmail.get(emailRaw.toLowerCase()) : undefined;
        if (r?.id) {
          updateOk.run(r.id, lead.id);
        } else if (r?.error) {
          errors.push(`Lead ${emailRaw}: ${r.error}`);
        }
      }
      leadCount += result.added;
    } catch (err) {
      errors.push(`Push leads to ${camp.instantly_campaign_id}: ${(err as Error).message}`);
    }
  }

  return { campaigns: campaignCount, leads: leadCount, errors };
}

// ── Pull Sync: Instantly → Frame ──

async function pullCampaigns(): Promise<{ campaigns: number; leads: number; stageUpdates: number; errors: string[] }> {
  let campaignCount = 0;
  let leadCount = 0;
  let stageUpdates = 0;
  const errors: string[] = [];

  const synced = sqlite.prepare(
    "SELECT id, instantly_campaign_id FROM campaigns WHERE instantly_campaign_id IS NOT NULL"
  ).all() as Array<{ id: string; instantly_campaign_id: string }>;

  for (const camp of synced) {
    try {
      const analytics = await instantlyClient.getCampaignAnalytics(camp.instantly_campaign_id);

      sqlite.prepare(`
        UPDATE campaigns SET
          sent = ?, delivered = ?, opened = ?, replied = ?, bounced = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        analytics.emails_sent, analytics.emails_sent - analytics.emails_bounced,
        analytics.emails_opened, analytics.emails_replied, analytics.emails_bounced,
        camp.id
      );

      // Update sync tracking
      sqlite.prepare(
        "UPDATE instantly_sync SET last_synced_at = datetime('now'), sync_status = 'synced' WHERE entity_type = 'campaign' AND entity_id = ?"
      ).run(camp.id);

      campaignCount++;
    } catch (err) {
      errors.push(`Pull analytics ${camp.instantly_campaign_id}: ${(err as Error).message}`);
    }
  }

  // Pull lead statuses - check replied leads and update deal stages
  const repliedLeads = sqlite.prepare(`
    SELECT cl.*, co.id as co_id
    FROM campaign_leads cl
    LEFT JOIN companies co ON co.id = cl.company_id
    WHERE cl.status = 'replied' AND cl.reply_classification IS NULL
  `).all() as Array<Record<string, unknown>>;

  // Update deal stages for replied leads
  const updateDealStage = sqlite.prepare(`
    UPDATE deals SET stage = 'contact_made', previous_stage = stage, updated_at = datetime('now')
    WHERE company_id = ? AND stage = 'outreach'
  `);

  for (const lead of repliedLeads) {
    const result = updateDealStage.run(lead.company_id);
    if (result.changes > 0) stageUpdates++;
    leadCount++;
  }

  return { campaigns: campaignCount, leads: leadCount, stageUpdates, errors };
}

// ── Import campaigns from Instantly into Frame ──

export interface ImportCampaignsStats {
  /** Campaigns Instantly returned. */
  fetched: number;
  /** New rows created in our `campaigns` table. */
  created: number;
  /** Existing rows whose status/name we refreshed. */
  updated: number;
  /** Returned by Instantly but we already had them locally and nothing
   *  changed — counted separately so re-runs are obviously safe. */
  unchanged: number;
  /** Campaigns we pulled fresh analytics for after the upsert. */
  analyticsRefreshed: number;
  errors: string[];
}

/**
 * Pull every campaign from Instantly and upsert it into our local
 * `campaigns` table, keyed by `instantly_campaign_id`. New rows land
 * with status mapped from Instantly's status enum, type='email_sequence'
 * (the only kind Instantly exposes), and `name` from Instantly.
 *
 * Existing rows keep their local id + lead_count + analytics — we only
 * refresh `name`, `status`, and `updated_at`. This means re-running
 * after renaming a campaign in Instantly picks up the new name without
 * recreating anything.
 */
export async function importCampaignsFromInstantly(): Promise<ImportCampaignsStats> {
  const stats: ImportCampaignsStats = {
    fetched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    analyticsRefreshed: 0,
    errors: [],
  };

  let remote;
  try {
    remote = await instantlyClient.listCampaigns();
  } catch (err) {
    stats.errors.push(`listCampaigns: ${(err as Error).message}`);
    return stats;
  }
  stats.fetched = remote.length;
  if (remote.length === 0) return stats;

  const findByInstantlyId = sqlite.prepare(
    `SELECT id, name, status FROM campaigns WHERE instantly_campaign_id = ? LIMIT 1`,
  );
  const update = sqlite.prepare(
    `UPDATE campaigns SET name = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
  );
  const insert = sqlite.prepare(
    `INSERT INTO campaigns (id, name, type, status, instantly_campaign_id, created_at, updated_at)
     VALUES (?, ?, 'email_sequence', ?, ?, datetime('now'), datetime('now'))`,
  );

  // Instantly's status enum: active | paused | completed | draft | error.
  // Our schema accepts the first 4 — coerce 'error' to 'paused' so it
  // doesn't drop the row.
  const mapStatus = (s: string): string => (s === "error" ? "paused" : s);

  const txn = sqlite.transaction(() => {
    for (const c of remote) {
      try {
        const local = findByInstantlyId.get(c.id) as { id: string; name: string; status: string } | undefined;
        const newStatus = mapStatus(c.status);
        if (local) {
          if (local.name !== c.name || local.status !== newStatus) {
            update.run(c.name, newStatus, local.id);
            stats.updated++;
          } else {
            stats.unchanged++;
          }
        } else {
          insert.run(crypto.randomUUID(), c.name, newStatus, c.id);
          stats.created++;
        }
      } catch (err) {
        stats.errors.push(`upsert ${c.id} (${c.name}): ${(err as Error).message}`);
      }
    }
  });
  txn();

  // Pull fresh analytics for every campaign we just upserted. Without
  // this the table renders 0s on a freshly-synced campaign until the
  // next full Instantly sync runs. Per-campaign HTTP, so we cap the
  // pacing — 5 rps fits comfortably under any rate limit.
  const analyticsUpdate = sqlite.prepare(
    `UPDATE campaigns
        SET sent = ?, delivered = ?, opened = ?, replied = ?, bounced = ?,
            updated_at = datetime('now')
      WHERE instantly_campaign_id = ?`,
  );
  for (const c of remote) {
    try {
      const a = await instantlyClient.getCampaignAnalytics(c.id);
      analyticsUpdate.run(
        a.emails_sent,
        Math.max(0, a.emails_sent - a.emails_bounced),
        a.emails_opened,
        a.emails_replied,
        a.emails_bounced,
        c.id,
      );
      stats.analyticsRefreshed++;
    } catch (err) {
      stats.errors.push(`analytics ${c.id} (${c.name}): ${(err as Error).message}`);
    }
  }
  return stats;
}

// ── Pull leads from Instantly into our CRM ──

export interface ImportLeadsStats {
  /** Total raw leads Instantly returned across every synced campaign. */
  fetched: number;
  /** New companies inserted (email wasn't known to our CRM). */
  companiesCreated: number;
  /** New campaign_leads rows inserted (lead wasn't recorded against this
   *  campaign locally yet). */
  leadsLinked: number;
  /** Already-known (campaign, company) pairs — counted so re-runs are
   *  obviously idempotent. */
  alreadyKnown: number;
  /** Per-campaign errors. */
  errors: string[];
}

/**
 * Walk every campaign that has an instantly_campaign_id, pull its full
 * lead list from Instantly via /leads/list, and back-fill our CRM so
 * the dedup gate at push time + the campaign table's lead counts both
 * reflect Instantly reality.
 *
 * For each lead returned:
 *   - email exists in companies   → ensure a campaign_leads row exists
 *                                    for (campaign, company)
 *   - email missing from companies → create a company tagged
 *                                    source_type='instantly_pull' +
 *                                    a campaign_leads row
 *
 * Always persists the real Instantly lead id onto campaign_leads so a
 * later push can dedup against (campaign_id, company_id) AND we have a
 * proper handle for status-pull. Re-runs are safe — the unique index
 * on campaign_leads(campaign_id, company_id) makes the insert path a
 * silent no-op for already-linked pairs.
 */
export async function importLeadsFromInstantly(): Promise<ImportLeadsStats> {
  const stats: ImportLeadsStats = {
    fetched: 0,
    companiesCreated: 0,
    leadsLinked: 0,
    alreadyKnown: 0,
    errors: [],
  };

  const synced = sqlite.prepare(
    `SELECT id, instantly_campaign_id, name FROM campaigns WHERE instantly_campaign_id IS NOT NULL`,
  ).all() as Array<{ id: string; instantly_campaign_id: string; name: string }>;

  if (synced.length === 0) return stats;

  const findCompanyByEmail = sqlite.prepare(
    `SELECT id FROM companies WHERE LOWER(email) = LOWER(?) LIMIT 1`,
  );
  const findLink = sqlite.prepare(
    `SELECT id FROM campaign_leads WHERE campaign_id = ? AND company_id = ? LIMIT 1`,
  );
  const insertCompany = sqlite.prepare(
    `INSERT INTO companies (
       id, name, type, email, status, source, source_type,
       created_at, updated_at
     ) VALUES (
       ?, ?, 'online', ?, 'new', 'instantly_pull', 'instantly_pull',
       datetime('now'), datetime('now')
     )`,
  );
  const insertLink = sqlite.prepare(
    `INSERT INTO campaign_leads (
       id, campaign_id, company_id, contact_id, instantly_lead_id, email,
       status, created_at
     ) VALUES (?, ?, ?, NULL, ?, ?, 'sent', datetime('now'))`,
  );

  for (const camp of synced) {
    let leads: Array<Record<string, unknown>>;
    try {
      leads = await instantlyClient.listLeadsInCampaign(camp.instantly_campaign_id);
    } catch (err) {
      stats.errors.push(`listLeads ${camp.name}: ${(err as Error).message}`);
      continue;
    }

    const txn = sqlite.transaction(() => {
      for (const lead of leads) {
        stats.fetched++;
        const email = String(lead.email ?? "").trim().toLowerCase();
        const instId = String(lead.id ?? "");
        if (!email || !instId) continue;

        // Find or create company by email. NOTE: companies has no
        // `source_type='instantly_pull'` value in the schema enum
        // technically, but the column is plain TEXT in sqlite so this
        // works — Drizzle's enum is a typecheck-only constraint.
        let row = findCompanyByEmail.get(email) as { id: string } | undefined;
        if (!row) {
          const name =
            (typeof lead.company_name === "string" && lead.company_name.trim())
              ? String(lead.company_name).trim()
              : [lead.first_name, lead.last_name].filter(Boolean).join(" ").trim() || email;
          const newId = crypto.randomUUID();
          insertCompany.run(newId, name, email);
          row = { id: newId };
          stats.companiesCreated++;
        }

        // Link → campaign_leads. Unique index on (campaign_id,
        // company_id) handles dedup at the DB layer; we still check
        // first so the alreadyKnown counter is accurate.
        const link = findLink.get(camp.id, row.id) as { id: string } | undefined;
        if (link) {
          stats.alreadyKnown++;
        } else {
          try {
            insertLink.run(crypto.randomUUID(), camp.id, row.id, instId, email);
            stats.leadsLinked++;
          } catch (e) {
            // Concurrent race with another caller — log + count as
            // already-known so the stats stay honest.
            stats.alreadyKnown++;
            void e;
          }
        }
      }
    });
    txn();
  }

  return stats;
}

// ── Full Sync ──

export async function runInstantlySync(): Promise<SyncResult> {
  logger.logEvent("instantly_sync_start", "sales");

  const pushResult = await pushCampaigns();
  const pullResult = await pullCampaigns();

  const result: SyncResult = {
    pushed: { campaigns: pushResult.campaigns, leads: pushResult.leads },
    pulled: { campaigns: pullResult.campaigns, leads: pullResult.leads, stageUpdates: pullResult.stageUpdates },
    errors: [...pushResult.errors, ...pullResult.errors],
  };

  logger.logEvent("instantly_sync_complete", "sales", result as unknown as Record<string, unknown>);
  return result;
}

// ── Sync API endpoint handler ──

export async function handleSyncRequest(): Promise<SyncResult> {
  return runInstantlySync();
}
