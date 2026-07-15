import { sqlite } from "@/lib/db";
import { phoneBurnerAccounts } from "./phoneburner-client";
import { resolveByPhone } from "./lead-resolution";
import { updatePerson } from "./pipedrive-client";

/**
 * Contact-edit writeback + reconciliation.
 *
 * PhoneBurner has no "contact field edited" webhook — its webhooks are
 * call/engagement-centric. So to keep the frame the source of truth when an
 * agent edits a contact's EMAIL in PhoneBurner, we poll the /contacts list
 * (ordered by date_updated) and sync any email that now differs from the frame
 * back into the frame (contacts + campaign_leads) and Pipedrive (person).
 *
 * The same core (applyEmailWriteback) is also called from the webhook handler
 * when PB does deliver a contact-update event, so both paths converge.
 */

function getSetting(key: string): string | null {
  return (sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value?.trim() || null;
}
function setSetting(key: string, value: string): void {
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, type, module, updated_at)
       VALUES (?, ?, 'string', 'phoneburner', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(key, value);
}

export function normalizeEmail(e: string | null | undefined): string | null {
  const s = (e ?? "").trim().toLowerCase();
  return s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/**
 * Apply an email edit to the frame + Pipedrive for a company. No-ops on an
 * unchanged/invalid email. Returns the list of surfaces actually changed.
 */
export async function applyEmailWriteback(opts: {
  companyId: string;
  campaignLeadId?: string | null;
  newEmail: string;
}): Promise<string[]> {
  const email = normalizeEmail(opts.newEmail);
  if (!email) return [];
  const changes: string[] = [];

  // Frame primary contact.
  const contact = sqlite
    .prepare("SELECT id, email FROM contacts WHERE company_id = ? ORDER BY is_primary DESC, created_at ASC LIMIT 1")
    .get(opts.companyId) as { id: string; email: string | null } | undefined;
  if (contact) {
    if ((contact.email ?? "").trim().toLowerCase() !== email) {
      sqlite.prepare("UPDATE contacts SET email = ?, updated_at = datetime('now') WHERE id = ?").run(email, contact.id);
      changes.push("frame contact");
    }
  } else {
    sqlite
      .prepare(
        `INSERT INTO contacts (id, company_id, email, is_primary, source, created_at, updated_at)
         VALUES (?, ?, ?, 1, 'phoneburner_writeback', datetime('now'), datetime('now'))`,
      )
      .run(crypto.randomUUID(), opts.companyId, email);
    changes.push("frame contact (created)");
  }

  // campaign_leads row, if known.
  if (opts.campaignLeadId) {
    const cl = sqlite.prepare("SELECT email FROM campaign_leads WHERE id = ?").get(opts.campaignLeadId) as { email: string | null } | undefined;
    if (cl && (cl.email ?? "").trim().toLowerCase() !== email) {
      sqlite.prepare("UPDATE campaign_leads SET email = ?, updated_at = datetime('now') WHERE id = ?").run(email, opts.campaignLeadId);
      changes.push("campaign_lead");
    }
  }

  // Pipedrive person (email is an array of values).
  const personId = (sqlite.prepare("SELECT pipedrive_person_id AS id FROM companies WHERE id = ?").get(opts.companyId) as { id: number | null } | undefined)?.id ?? null;
  if (personId) {
    try {
      await updatePerson(personId, { email: [email] });
      changes.push("pipedrive person");
    } catch (e) {
      changes.push(`pipedrive failed(${e instanceof Error ? e.message.slice(0, 60) : "err"})`);
    }
  }

  if (changes.length) {
    try {
      sqlite
        .prepare(
          `INSERT INTO activity_feed (id, event_type, module, entity_type, entity_id, data, user_id, created_at)
           VALUES (?, 'phoneburner_contact_email_synced', 'sales', 'company', ?, ?, NULL, datetime('now'))`,
        )
        .run(crypto.randomUUID(), opts.companyId, JSON.stringify({ email, changed: changes }));
    } catch {
      /* activity feed is best-effort */
    }
  }
  return changes;
}

/**
 * Poll each PhoneBurner account for recently-updated contacts and sync any email
 * that now differs from the frame. Resolves a PB contact → frame company by the
 * (stable) phone number. Watermark per account so each run only looks at what
 * changed since last time.
 */
export async function reconcileContactEdits(opts: { maxPages?: number; pageSize?: number; resetWatermark?: boolean } = {}): Promise<{
  accounts: Array<{ rep: string; scanned: number; synced: number; pages: number; errors: number }>;
}> {
  const maxPages = Math.max(1, opts.maxPages ?? 5);
  const pageSize = Math.max(10, opts.pageSize ?? 100);
  const out: Array<{ rep: string; scanned: number; synced: number; pages: number; errors: number }> = [];

  for (const acct of phoneBurnerAccounts()) {
    const watermarkKey = `pb_contact_sync_watermark_${acct.rep}`;
    if (opts.resetWatermark) sqlite.prepare("DELETE FROM settings WHERE key = ?").run(watermarkKey);
    const prevWatermark = getSetting(watermarkKey); // ISO-ish "YYYY-MM-DD HH:MM:SS"
    let newWatermark = prevWatermark;
    let scanned = 0,
      synced = 0,
      pages = 0,
      errors = 0;

    for (let page = 1; page <= maxPages; page++) {
      let res;
      try {
        res = await acct.client.listContactsByUpdated({ page, pageSize });
      } catch (e) {
        errors++;
        console.error(`[pb-contact-sync] ${acct.rep} list page ${page} failed:`, e instanceof Error ? e.message : e);
        break;
      }
      pages++;
      if (!res.contacts.length) break;

      let reachedOld = false;
      for (const c of res.contacts) {
        // Track the newest timestamp we've seen to advance the watermark.
        if (c.dateUpdated && (!newWatermark || c.dateUpdated > newWatermark)) newWatermark = c.dateUpdated;
        // Sorted desc by date_updated — once we pass the previous watermark,
        // everything after is already-seen, so stop.
        if (prevWatermark && c.dateUpdated && c.dateUpdated <= prevWatermark) {
          reachedOld = true;
          break;
        }
        scanned++;
        const email = normalizeEmail(c.email);
        if (!email || !c.phone) continue;
        const match = resolveByPhone(c.phone);
        if (!match) continue;
        // Only write when the frame's current email differs (an actual edit).
        const contact = sqlite
          .prepare("SELECT email FROM contacts WHERE company_id = ? ORDER BY is_primary DESC, created_at ASC LIMIT 1")
          .get(match.companyId) as { email: string | null } | undefined;
        if (contact && (contact.email ?? "").trim().toLowerCase() === email) continue;
        try {
          const changed = await applyEmailWriteback({ companyId: match.companyId, campaignLeadId: match.campaignLeadId, newEmail: email });
          if (changed.length) synced++;
        } catch (e) {
          errors++;
          console.error(`[pb-contact-sync] writeback failed for ${match.companyId}:`, e instanceof Error ? e.message : e);
        }
      }
      if (reachedOld || (res.totalPages != null && page >= res.totalPages)) break;
    }

    if (newWatermark && newWatermark !== prevWatermark) setSetting(watermarkKey, newWatermark);
    out.push({ rep: acct.rep, scanned, synced, pages, errors });
  }

  return { accounts: out };
}
