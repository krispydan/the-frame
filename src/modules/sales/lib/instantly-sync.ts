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
    const unsentLeads = sqlite.prepare(`
      SELECT cl.*, co.name as company_name, ct.first_name, ct.last_name, ct.email as contact_email, ct.phone as contact_phone, co.website
      FROM campaign_leads cl
      LEFT JOIN companies co ON co.id = cl.company_id
      LEFT JOIN contacts ct ON ct.id = cl.contact_id
      WHERE cl.campaign_id = ? AND cl.instantly_lead_id IS NULL AND cl.email IS NOT NULL
    `).all(camp.id) as Array<Record<string, unknown>>;

    if (unsentLeads.length === 0) continue;

    const leads: InstantlyLead[] = unsentLeads.map((l) => ({
      email: (l.email || l.contact_email) as string,
      first_name: l.first_name as string | undefined,
      last_name: l.last_name as string | undefined,
      company_name: l.company_name as string | undefined,
      phone: l.contact_phone as string | undefined,
      website: l.website as string | undefined,
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
