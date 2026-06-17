/**
 * PhoneBurner push + pull engines.
 *
 * Push: pushCampaignToPhoneBurner(campaignId)
 *   - Ensures a PB folder exists for the campaign (creates if missing).
 *   - For each lead in the campaign, builds a PB contact payload using
 *     the firmographic data on companies + contacts, normalizes the
 *     phone, and POSTs to /rest/1/contacts. Stamps the returned PB
 *     contact id back onto campaign_leads.
 *
 * Pull: pullPhoneBurnerCallResults({ sinceMinutes })
 *   - Polls PB's /calls list for events since the last successful
 *     ingest. Resolves each call back to a campaign_lead via three
 *     paths in order of confidence: user_id round-trip, then
 *     phoneburner_contact_id, then phone. Inserts a row into
 *     phoneburner_call_log (PK is PB's call_id — retries fail
 *     INSERT silently for free idempotency), updates campaign_leads
 *     denormalized last-call state, and writes an entry to
 *     activity_feed for the prospect timeline.
 */
import { sqlite } from "@/lib/db";
import { phoneBurnerClient, type PbContactPayload, type PbCall } from "./phoneburner-client";
import { formatToPbPhone } from "./phone-utils";
import {
  resolveByCampaignLeadId,
  resolveByPbContactId,
  resolveByPhone,
  type ResolveResult,
} from "./lead-resolution";

// ────────────────────────────────────────────────────────────────
// Push
// ────────────────────────────────────────────────────────────────

interface PushSummary {
  ok: boolean;
  folder_id: string | null;
  pushed: number;
  skipped_no_phone: number;
  skipped_already_pushed: number;
  errors: Array<{ leadId: string; reason: string }>;
}

interface CampaignRow {
  id: string;
  name: string;
  type: string;
  phoneburner_folder_id: string | null;
}

interface LeadRowJoined {
  lead_id: string;
  company_id: string;
  contact_id: string | null;
  email: string | null;
  phoneburner_contact_id: string | null;
  // company fields
  company_name: string | null;
  website: string | null;
  domain: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  address: string | null;
  description: string | null;
  industry: string | null;
  icp_tier: string | null;
  icp_score: number | null;
  source_type: string | null;
  ecom_platform: string | null;
  estimated_yearly_sales_cents: number | null;
  // primary phone (from company_phones join)
  primary_phone: string | null;
  // optional contact name (contacts table stores first/last separately)
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_email: string | null;
}

function loadCampaign(campaignId: string): CampaignRow | null {
  const row = sqlite
    .prepare(
      `SELECT id, name, type, phoneburner_folder_id
         FROM campaigns WHERE id = ? LIMIT 1`,
    )
    .get(campaignId) as CampaignRow | undefined;
  return row ?? null;
}

async function ensurePbFolder(campaign: CampaignRow): Promise<string> {
  if (campaign.phoneburner_folder_id) return campaign.phoneburner_folder_id;

  // Try to find an existing folder with the same name first — avoids
  // duplicating folders when someone manually created one in PB before.
  const existing = await phoneBurnerClient.listFolders();
  const wantedName = campaign.name.trim().toLowerCase();
  const match = existing.find((f) => (f.name ?? "").trim().toLowerCase() === wantedName);
  let folderId: string;
  if (match) {
    folderId = match.id;
  } else {
    const created = await phoneBurnerClient.createFolder({
      folder_name: campaign.name,
      description: `Synced from The Frame — campaign ${campaign.id}`,
    });
    folderId = created.id;
  }
  sqlite
    .prepare("UPDATE campaigns SET phoneburner_folder_id = ? WHERE id = ?")
    .run(folderId, campaign.id);
  return folderId;
}

function loadLeadsForCampaign(campaignId: string): LeadRowJoined[] {
  return sqlite
    .prepare(
      `SELECT cl.id              AS lead_id,
              cl.company_id      AS company_id,
              cl.contact_id      AS contact_id,
              cl.email           AS email,
              cl.phoneburner_contact_id AS phoneburner_contact_id,
              co.name            AS company_name,
              co.website         AS website,
              co.domain          AS domain,
              co.city            AS city,
              co.state           AS state,
              co.zip             AS zip,
              co.address         AS address,
              co.description     AS description,
              co.industry        AS industry,
              co.icp_tier        AS icp_tier,
              co.icp_score       AS icp_score,
              co.source_type     AS source_type,
              co.ecom_platform   AS ecom_platform,
              co.estimated_yearly_sales_cents AS estimated_yearly_sales_cents,
              (SELECT cp.phone FROM company_phones cp
                WHERE cp.company_id = co.id
                ORDER BY cp.is_primary DESC, cp.created_at ASC
                LIMIT 1) AS primary_phone,
              ct.first_name      AS contact_first_name,
              ct.last_name       AS contact_last_name,
              ct.email           AS contact_email
         FROM campaign_leads cl
         JOIN companies co ON co.id = cl.company_id
         LEFT JOIN contacts ct ON ct.id = cl.contact_id
        WHERE cl.campaign_id = ?
          AND COALESCE(cl.dismissed, 0) = 0`,
    )
    .all(campaignId) as LeadRowJoined[];
}

/** Contacts table already has first/last separate; use them directly. */
function pickName(lead: { contact_first_name: string | null; contact_last_name: string | null }): {
  first?: string;
  last?: string;
} {
  const first = (lead.contact_first_name ?? "").trim();
  const last = (lead.contact_last_name ?? "").trim();
  return {
    first: first || undefined,
    last: last || undefined,
  };
}

function fmtMoneyFromCents(cents: number | null): string | null {
  if (cents == null || !Number.isFinite(cents)) return null;
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${Math.round(dollars / 1_000)}K`;
  return `$${Math.round(dollars)}`;
}

function buildContactPayload(opts: {
  lead: LeadRowJoined;
  folderId: string;
  ownerId: string;
}): PbContactPayload | null {
  const { lead, folderId, ownerId } = opts;
  const phone = formatToPbPhone(lead.primary_phone);
  if (!phone) return null;

  const { first, last } = pickName(lead);
  const email = (lead.email ?? lead.contact_email ?? "").trim() || undefined;

  // Custom fields carry firmographics — PB has no native company/website.
  const custom_fields = [
    { name: "company_name", value: lead.company_name ?? "" },
    { name: "website", value: lead.website ?? "" },
    { name: "domain", value: lead.domain ?? "" },
    { name: "lead_source", value: lead.source_type ?? "" },
    {
      name: "description",
      value: (lead.description ?? "").slice(0, 500),
    },
    { name: "industry", value: lead.industry ?? "" },
    { name: "icp_tier", value: lead.icp_tier ?? "" },
    { name: "icp_score", value: lead.icp_score ?? "" },
    {
      name: "estimated_yearly_sales",
      value: fmtMoneyFromCents(lead.estimated_yearly_sales_cents) ?? "",
    },
    { name: "ecom_platform", value: lead.ecom_platform ?? "" },
  ].filter((f) => f.value !== "" && f.value !== null && f.value !== undefined);

  return {
    owner_id: ownerId,
    first_name: first,
    last_name: last,
    email,
    phone,
    phone_type: 2, // work
    address1: lead.address ?? undefined,
    city: lead.city ?? undefined,
    state: lead.state ?? undefined,
    zip: lead.zip ?? undefined,
    country: "US",
    category_id: folderId,
    notes: lead.company_name ? `Account: ${lead.company_name}` : undefined,
    user_id: lead.lead_id,
    custom_fields,
    on_duplicate: "update",
  };
}

/** Run up to `concurrency` async tasks at a time. */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Resolve the PhoneBurner owner_id we'll stamp on every contact create.
 * PB requires owner_id (or owner_username) and has no /me endpoint,
 * so we discover it once by inspecting an existing contact and cache
 * in settings.phoneburner_owner_id.
 */
async function resolveOwnerId(): Promise<string> {
  const fromSettings = sqlite
    .prepare("SELECT value FROM settings WHERE key = 'phoneburner_owner_id' LIMIT 1")
    .get() as { value: string | null } | undefined;
  if (fromSettings?.value) return fromSettings.value;

  const discovered = await phoneBurnerClient.discoverOwnerId();
  if (!discovered) {
    throw new Error(
      "Could not discover PhoneBurner owner_id — workspace appears empty. " +
        "Create at least one contact in PB manually first, then re-run.",
    );
  }
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, type, module, updated_at)
       VALUES ('phoneburner_owner_id', ?, 'string', 'phoneburner', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(discovered);
  return discovered;
}

export async function pushCampaignToPhoneBurner(
  campaignId: string,
  opts?: { dryRun?: boolean },
): Promise<PushSummary> {
  const campaign = loadCampaign(campaignId);
  if (!campaign) {
    throw new Error(`Campaign ${campaignId} not found`);
  }

  const folderId = opts?.dryRun
    ? campaign.phoneburner_folder_id ?? "(dry-run, would create)"
    : await ensurePbFolder(campaign);

  // owner_id is required on every contact create; resolved once
  // per push and reused. Dry-run skips the API call.
  const ownerId = opts?.dryRun ? "(dry-run-owner)" : await resolveOwnerId();

  const leads = loadLeadsForCampaign(campaignId);

  const summary: PushSummary = {
    ok: true,
    folder_id: folderId,
    pushed: 0,
    skipped_no_phone: 0,
    skipped_already_pushed: 0,
    errors: [],
  };

  // Build payloads first so we can short-circuit on phone/already-pushed
  // without hitting PB at all.
  type Plan = { lead: LeadRowJoined; payload: PbContactPayload };
  const toPush: Plan[] = [];
  for (const lead of leads) {
    if (lead.phoneburner_contact_id) {
      summary.skipped_already_pushed++;
      continue;
    }
    const payload = buildContactPayload({
      lead,
      folderId: typeof folderId === "string" ? folderId : "",
      ownerId,
    });
    if (!payload) {
      summary.skipped_no_phone++;
      continue;
    }
    toPush.push({ lead, payload });
  }

  if (opts?.dryRun) {
    return {
      ...summary,
      pushed: toPush.length,
      // Surface what would happen
    };
  }

  // Single-contact endpoint — concurrency-limited, retry inside the client.
  const stampStmt = sqlite.prepare(
    "UPDATE campaign_leads SET phoneburner_contact_id = ? WHERE id = ?",
  );
  await runWithConcurrency(toPush, 5, async (p) => {
    try {
      const created = await phoneBurnerClient.createContact(p.payload);
      stampStmt.run(created.id, p.lead.lead_id);
      summary.pushed++;
    } catch (e) {
      summary.errors.push({
        leadId: p.lead.lead_id,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  });

  return summary;
}

// ────────────────────────────────────────────────────────────────
// Pull (polling cron)
// ────────────────────────────────────────────────────────────────

interface PullSummary {
  ok: boolean;
  since: string;
  ingested: number;
  skipped_existing: number;
  unmatched: number;
  errors: Array<{ callId: string; reason: string }>;
}

function lastIngestedCalledAt(): string | null {
  const row = sqlite
    .prepare("SELECT MAX(called_at) AS m FROM phoneburner_call_log")
    .get() as { m: string | null } | undefined;
  return row?.m ?? null;
}

function callExists(callId: string): boolean {
  const row = sqlite
    .prepare("SELECT 1 FROM phoneburner_call_log WHERE id = ? LIMIT 1")
    .get(callId) as { 1: number } | undefined;
  return !!row;
}

function resolveCall(call: PbCall): ResolveResult | null {
  const userId = call.user_id ?? null; // our campaign_lead.id, round-tripped
  const r1 = resolveByCampaignLeadId(userId);
  if (r1) return r1;
  const r2 = resolveByPbContactId(call.contact_id ?? null);
  if (r2) return r2;
  return resolveByPhone(call.phone ?? null);
}

function ingestOneCall(call: PbCall): "ingested" | "skipped_existing" | "unmatched" {
  const callId = call.id || call.call_id;
  if (!callId) return "skipped_existing";
  if (callExists(callId)) return "skipped_existing";

  const match = resolveCall(call);
  const companyId = match?.companyId ?? null;
  const campaignLeadId = match?.campaignLeadId ?? null;

  const disposition =
    call.disposition_label ?? call.disposition ?? null;
  const dispositionId = call.disposition_id ?? null;
  const calledAt =
    call.called_at ?? call.timestamp ?? new Date().toISOString();

  sqlite
    .prepare(
      `INSERT INTO phoneburner_call_log
       (id, campaign_lead_id, company_id, phoneburner_contact_id,
        agent_id, agent_email, duration_seconds, connected,
        disposition_label, disposition_id, notes, recording_url,
        called_at, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      callId,
      campaignLeadId,
      companyId,
      call.contact_id ?? null,
      call.agent_id ?? null,
      call.agent_email ?? null,
      typeof call.duration === "number" ? Math.round(call.duration) : null,
      call.connected ? 1 : 0,
      disposition,
      dispositionId,
      call.notes ?? null,
      call.recording_url ?? null,
      calledAt,
    );

  if (campaignLeadId) {
    sqlite
      .prepare(
        `UPDATE campaign_leads
            SET last_called_at = ?,
                last_call_disposition = ?,
                call_count = COALESCE(call_count, 0) + 1
          WHERE id = ?`,
      )
      .run(calledAt, disposition, campaignLeadId);
  }

  if (companyId) {
    try {
      sqlite
        .prepare(
          `INSERT INTO activity_feed
             (id, event_type, module, entity_type, entity_id, data, user_id, created_at)
           VALUES (?, 'phoneburner_call_completed', 'sales', 'company', ?, ?, NULL, datetime('now'))`,
        )
        .run(
          crypto.randomUUID(),
          companyId,
          JSON.stringify({
            disposition,
            disposition_id: dispositionId,
            duration_seconds: call.duration ?? null,
            recording_url: call.recording_url ?? null,
            agent_id: call.agent_id ?? null,
            agent_email: call.agent_email ?? null,
            notes: call.notes ? String(call.notes).slice(0, 500) : null,
            called_at: calledAt,
            call_id: callId,
          }),
        );
    } catch (e) {
      console.error("[phoneburner-sync] activity_feed insert failed:", e);
    }
  }

  return companyId ? "ingested" : "unmatched";
}

export async function pullPhoneBurnerCallResults(opts?: {
  sinceMinutes?: number;
}): Promise<PullSummary> {
  const sinceMin = opts?.sinceMinutes ?? 15;
  const high = lastIngestedCalledAt();
  const sinceIso =
    high ??
    new Date(Date.now() - sinceMin * 60 * 1000).toISOString();

  const summary: PullSummary = {
    ok: true,
    since: sinceIso,
    ingested: 0,
    skipped_existing: 0,
    unmatched: 0,
    errors: [],
  };

  let page = 1;
  while (true) {
    let batch: PbCall[];
    try {
      batch = await phoneBurnerClient.listRecentCalls({
        since: sinceIso,
        page,
        page_size: 100,
      });
    } catch (e) {
      summary.errors.push({
        callId: `(page ${page})`,
        reason: e instanceof Error ? e.message : String(e),
      });
      summary.ok = false;
      break;
    }
    if (batch.length === 0) break;

    for (const call of batch) {
      try {
        const outcome = ingestOneCall(call);
        if (outcome === "ingested") summary.ingested++;
        else if (outcome === "skipped_existing") summary.skipped_existing++;
        else summary.unmatched++;
      } catch (e) {
        summary.errors.push({
          callId: call.id || call.call_id || "(unknown)",
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (batch.length < 100) break;
    page++;
    if (page > 50) break; // safety cap — 5000 calls per poll
  }

  return summary;
}
