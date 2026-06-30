/**
 * Pipedrive sync engine.
 *
 * The push half of the Pipedrive integration (the pull half lives in
 * pipedrive-webhooks.ts). Three entry edges, all idempotent:
 *
 *  1. AJM seed       — seedAjmToPipedrive(): the curated ~1,173 contacts
 *     tagged `ajm_pipedrive_push` are seeded into AJM Reactivation (To
 *     Contact), owned by Christina. The one deliberate, non-interest-gated
 *     entry into Pipedrive (docs §3.2).
 *  2. Interest edge  — ensureOutreachDeal() / backfillInterested(): a company
 *     that shows interest gets an open deal in AJM Reactivation (if it's an
 *     AJM contact — overlap stays in AJM, docs §3.3) or Catalog Interested.
 *  3. Order edge     — createDealForOrder(): a wholesale order wins the org's
 *     open outreach deal if one exists, else creates a Won deal in Customers
 *     (docs §7). Revenue truth stays on `orders`; deal value is display-only.
 *
 * Dedup law (docs §4): resolve before create; never create a duplicate; never
 * overwrite a record we didn't create. Primary key is the stamped id on the
 * frame record (companies.pipedrive_org_id/person_id, orders.pipedrive_deal_id,
 * pipedrive_deals.pipedrive_deal_id). Org/person also carry a `frame_company_id`
 * custom field so a crash between Pipedrive-create and frame-stamp is recovered
 * by search, and so inbound webhooks can resolve back to the frame.
 */

import crypto from "crypto";
import { sqlite } from "@/lib/db";
import {
  pdRequest,
  createOrganization,
  updateOrganization,
  createPerson,
  createDeal,
  updateDeal,
  findPersonIdByEmail,
  getPipedriveConnectionStatus,
  PipedriveError,
  type PdCreated,
} from "./pipedrive-client";
import { getPipelineConfig, getPipedriveOwner, type PipelineConfig } from "./pipedrive-setup";

// ── settings helpers ────────────────────────────────────────────────────────

function getSetting(key: string): string | null {
  const r = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string | null }
    | undefined;
  return r?.value ?? null;
}
function setSetting(key: string, value: string): void {
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, type, module, updated_at)
       VALUES (?, ?, 'string', 'sales', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(key, value);
}

// ── custom fields ───────────────────────────────────────────────────────────

export interface CustomFieldKeys {
  orgFrameCompanyId: string;
  orgWebsite: string;
  dealFrameCompanyId: string;
  dealFrameOrderId: string;
  dealBackfillRunId: string;
}

interface PdFieldDef {
  key: string;
  name: string;
}

/**
 * Resolve (creating if needed) a custom field key. Returns "" if the field
 * can't be created/read — creating fields needs an admin scope the app may
 * not have. The sync degrades gracefully: dedup still works via the stamped
 * ids on frame records; only the secondary search-based recovery and inbound
 * manual-deal linking lose their custom-field fallback.
 */
async function ensureField(endpoint: "/organizationFields" | "/dealFields", name: string): Promise<string> {
  try {
    const existing = (await pdRequest<PdFieldDef[]>("GET", endpoint)) || [];
    const found = existing.find((f) => f.name.trim().toLowerCase() === name.toLowerCase());
    if (found) return found.key;
    const created = await pdRequest<PdFieldDef>("POST", endpoint, { name, field_type: "varchar" });
    return created.key;
  } catch (e) {
    console.warn(`[pipedrive-sync] custom field ${endpoint}/${name} unavailable:`, e instanceof Error ? e.message : e);
    return "";
  }
}

/**
 * Create (idempotently) the custom fields the sync relies on for dedup +
 * inbound resolution, and cache their hashed keys in settings. Any field that
 * can't be provisioned is cached as "" and simply not set on records.
 */
export async function ensureCustomFields(): Promise<CustomFieldKeys> {
  const cached = getSetting("pipedrive_custom_fields");
  if (cached) {
    try {
      const k = JSON.parse(cached) as CustomFieldKeys;
      // Re-resolve only if we've never recorded a value for every field
      // (new fields like orgWebsite trigger a one-time re-provision).
      if (
        "orgFrameCompanyId" in k &&
        "orgWebsite" in k &&
        "dealFrameCompanyId" in k &&
        "dealFrameOrderId" in k &&
        "dealBackfillRunId" in k
      ) {
        return k;
      }
    } catch {
      /* re-provision below */
    }
  }
  const keys: CustomFieldKeys = {
    orgFrameCompanyId: await ensureField("/organizationFields", "frame_company_id"),
    orgWebsite: await ensureField("/organizationFields", "website"),
    dealFrameCompanyId: await ensureField("/dealFields", "frame_company_id"),
    dealFrameOrderId: await ensureField("/dealFields", "frame_order_id"),
    dealBackfillRunId: await ensureField("/dealFields", "backfill_run_id"),
  };
  setSetting("pipedrive_custom_fields", JSON.stringify(keys));
  return keys;
}

// ── frame-record helpers (raw sqlite, mirrors phoneburner/instantly sync) ────

interface CompanyRow {
  id: string;
  name: string | null;
  pipedrive_org_id: number | null;
  pipedrive_person_id: number | null;
  source: string | null;
  tags: string | null;
  status: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  website: string | null;
}

function getCompany(companyId: string): CompanyRow | undefined {
  return sqlite
    .prepare(
      `SELECT id, name, pipedrive_org_id, pipedrive_person_id, source, tags, status,
              address, city, state, zip, website
         FROM companies WHERE id = ?`,
    )
    .get(companyId) as CompanyRow | undefined;
}

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "aol.com", "comcast.net", "msn.com",
  "outlook.com", "icloud.com", "sbcglobal.net", "verizon.net", "cox.net", "me.com",
  "bellsouth.net", "earthlink.net", "mac.com", "ymail.com", "live.com", "att.net",
  "q.com", "centurylink.net", "protonmail.com", "ATTGLOBAL.NET".toLowerCase(),
]);

/** Compose a single-line address from the company's parts (Pipedrive org.address). */
function composeAddress(c: CompanyRow): string | null {
  const parts = [c.address, c.city, c.state, c.zip].map((s) => (s || "").trim()).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/**
 * Pick a website for the org: the company's website if set, else derive it
 * from a non-free primary-email domain (a business email domain is the site).
 */
function deriveWebsite(c: CompanyRow, primaryEmail: string | null): string | null {
  if (c.website && c.website.trim()) return c.website.trim();
  if (primaryEmail) {
    const at = primaryEmail.lastIndexOf("@");
    const domain = at >= 0 ? primaryEmail.slice(at + 1).toLowerCase().trim() : "";
    if (domain && !FREE_EMAIL_DOMAINS.has(domain) && !domain.endsWith("relay.faire.com")) {
      return `https://${domain}`;
    }
  }
  return null;
}

function getPrimaryEmail(companyId: string): string | null {
  const r = sqlite
    .prepare(
      `SELECT email FROM contacts
        WHERE company_id = ? AND TRIM(COALESCE(email,'')) <> ''
        ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
    )
    .get(companyId) as { email: string } | undefined;
  return r?.email ?? null;
}
function getPrimaryPhone(companyId: string): string | null {
  const r = sqlite
    .prepare(
      `SELECT phone FROM company_phones
        WHERE company_id = ? ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
    )
    .get(companyId) as { phone: string } | undefined;
  return r?.phone ?? null;
}
function getPrimaryContactName(companyId: string): string | null {
  const r = sqlite
    .prepare(
      `SELECT first_name, last_name FROM contacts
        WHERE company_id = ? ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
    )
    .get(companyId) as { first_name: string | null; last_name: string | null } | undefined;
  if (!r) return null;
  const name = [r.first_name, r.last_name].filter((s) => s && s.trim()).join(" ").trim();
  return name || null;
}

function stampOrg(companyId: string, orgId: number): void {
  sqlite
    .prepare("UPDATE companies SET pipedrive_org_id = ?, pipedrive_synced_at = datetime('now') WHERE id = ?")
    .run(orgId, companyId);
}
function stampPerson(companyId: string, personId: number): void {
  sqlite
    .prepare("UPDATE companies SET pipedrive_person_id = ?, pipedrive_synced_at = datetime('now') WHERE id = ?")
    .run(personId, companyId);
}

/** AJM contact = full-cohort import OR carries the ajm_2025 tag (docs §3.3). */
function isAjmCompany(c: CompanyRow): boolean {
  if (c.source === "ajm_2025_import") return true;
  return typeof c.tags === "string" && c.tags.toLowerCase().includes("ajm_2025");
}

// ── connection guard ────────────────────────────────────────────────────────

export class PipedriveNotReadyError extends Error {}

/**
 * Master switch for the AUTOMATIC edges (go-forward interest fan-out + the
 * order-deal cron sweep). Default off so deploying the integration doesn't
 * start creating deals before Daniel runs the dry-run backfill + sign-off
 * (docs §9.3). Manual admin/preview actions ignore this flag. Flip on from
 * the settings page when ready.
 */
export function isSyncEnabled(): boolean {
  return getSetting("pipedrive_sync_enabled") === "true";
}
export function setSyncEnabled(on: boolean): void {
  setSetting("pipedrive_sync_enabled", on ? "true" : "false");
}

function requireConfig(): { config: PipelineConfig; ownerId: number | undefined } {
  if (!getPipedriveConnectionStatus().connected) {
    throw new PipedriveNotReadyError("Pipedrive is not connected");
  }
  const config = getPipelineConfig();
  if (!config) throw new PipedriveNotReadyError("Pipedrive pipelines not provisioned — run setup first");
  return { config, ownerId: getPipedriveOwner()?.id };
}

// ── org / person resolution ─────────────────────────────────────────────────

/** Resolve (or create) the Pipedrive Organization for a frame company. */
export async function resolveOrg(companyId: string, ownerId?: number): Promise<number> {
  const c = getCompany(companyId);
  if (!c) throw new Error(`company ${companyId} not found`);

  const keys = await ensureCustomFields();

  // Address (native field) + website (custom field — orgs have no native
  // website; derive from a business email domain when not explicitly set).
  const enrich: Record<string, unknown> = {};
  const address = composeAddress(c);
  if (address) enrich.address = address;
  if (keys.orgWebsite) {
    const website = deriveWebsite(c, getPrimaryEmail(companyId));
    if (website) enrich[keys.orgWebsite] = website;
  }

  // Already linked → enrich the existing org with address/website (best-effort)
  // so orgs created before this data was available still get it, then return.
  if (c.pipedrive_org_id) {
    if (Object.keys(enrich).length) {
      try {
        await updateOrganization(c.pipedrive_org_id, enrich);
      } catch (e) {
        console.warn("[pipedrive-sync] org enrich failed (non-fatal):", e instanceof Error ? e.message : e);
      }
    }
    return c.pipedrive_org_id;
  }

  const name = (c.name || "").trim();

  // Recover from a crash-between-create-and-stamp: an org we already made
  // carries our frame_company_id. Match by exact name, verify the custom field.
  // Search is only a dedup optimization — if it fails (e.g. search:read scope
  // not granted), fall through to create rather than aborting the whole row.
  if (name && keys.orgFrameCompanyId) {
    try {
      const found = await pdRequest<{ items?: Array<{ item?: { id?: number } }> }>(
        "GET",
        `/organizations/search?term=${encodeURIComponent(name)}&fields=name&exact_match=true&limit=5`,
      );
      for (const it of found?.items ?? []) {
        const id = it.item?.id;
        if (!id) continue;
        const detail = await pdRequest<Record<string, unknown>>("GET", `/organizations/${id}`);
        if (String(detail?.[keys.orgFrameCompanyId] ?? "") === companyId) {
          stampOrg(companyId, id);
          return id;
        }
      }
    } catch (e) {
      console.warn("[pipedrive-sync] org search failed (non-fatal):", e instanceof Error ? e.message : e);
    }
  }

  const body: Record<string, unknown> = { name: name || "Unknown company", ...enrich };
  if (keys.orgFrameCompanyId) body[keys.orgFrameCompanyId] = companyId;
  if (ownerId) body.owner_id = ownerId;
  const created = await createOrganization(body as { name: string });
  stampOrg(companyId, created.id);
  return created.id;
}

/** Resolve (or create) the Pipedrive Person for a frame company's primary contact. */
export async function resolvePerson(companyId: string, orgId: number, ownerId?: number): Promise<number | null> {
  const c = getCompany(companyId);
  if (!c) return null;
  if (c.pipedrive_person_id) return c.pipedrive_person_id;

  const email = getPrimaryEmail(companyId);
  const phone = getPrimaryPhone(companyId);
  const name = getPrimaryContactName(companyId) || (c.name || "").trim();
  if (!name && !email && !phone) return null;

  if (email) {
    // Non-fatal: search is a dedup optimization, not required to create.
    try {
      const existing = await findPersonIdByEmail(email);
      if (existing) {
        stampPerson(companyId, existing);
        return existing;
      }
    } catch (e) {
      console.warn("[pipedrive-sync] person search failed (non-fatal):", e instanceof Error ? e.message : e);
    }
  }

  const body: Record<string, unknown> = { name: name || email || "Unknown", org_id: orgId };
  if (email) body.email = [email];
  if (phone) body.phone = [phone];
  if (ownerId) body.owner_id = ownerId;
  const created = await createPerson(body as { name: string });
  stampPerson(companyId, created.id);
  return created.id;
}

// ── deal projection helpers ─────────────────────────────────────────────────

interface PdDealRow {
  id: string;
  pipedrive_deal_id: number | null;
  company_id: string | null;
  order_id: string | null;
  pipeline: string | null;
  stage: string | null;
  status: string | null;
  is_open: number;
}

function findOpenDealInPipeline(companyId: string, pipeline: string): PdDealRow | undefined {
  return sqlite
    .prepare(
      `SELECT * FROM pipedrive_deals
        WHERE company_id = ? AND pipeline = ? AND is_open = 1 AND pipedrive_deal_id IS NOT NULL
        ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(companyId, pipeline) as PdDealRow | undefined;
}
function findAnyOpenDeal(companyId: string): PdDealRow | undefined {
  return sqlite
    .prepare(
      `SELECT * FROM pipedrive_deals
        WHERE company_id = ? AND is_open = 1 AND pipedrive_deal_id IS NOT NULL
        ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(companyId) as PdDealRow | undefined;
}

function upsertProjection(input: {
  pipedriveDealId: number;
  companyId?: string | null;
  orderId?: string | null;
  pipeline: string;
  stage: string;
  status: "open" | "won" | "lost";
  value?: number | null;
  title?: string | null;
  backfillRunId?: string | null;
}): void {
  sqlite
    .prepare(
      `INSERT INTO pipedrive_deals
         (id, pipedrive_deal_id, company_id, order_id, pipeline, stage, status, is_open, value, title, backfill_run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(pipedrive_deal_id) DO UPDATE SET
         company_id = COALESCE(excluded.company_id, company_id),
         order_id = COALESCE(excluded.order_id, order_id),
         pipeline = excluded.pipeline,
         stage = excluded.stage,
         status = excluded.status,
         is_open = excluded.is_open,
         value = COALESCE(excluded.value, value),
         title = COALESCE(excluded.title, title),
         backfill_run_id = COALESCE(excluded.backfill_run_id, backfill_run_id),
         updated_at = datetime('now')`,
    )
    .run(
      crypto.randomUUID(),
      input.pipedriveDealId,
      input.companyId ?? null,
      input.orderId ?? null,
      input.pipeline,
      input.stage,
      input.status,
      input.status === "open" ? 1 : 0,
      input.value ?? null,
      input.title ?? null,
      input.backfillRunId ?? null,
    );
}

function pipelineMeta(config: PipelineConfig, key: "ajm" | "catalog" | "customers") {
  const p = config[key];
  const stageNames = Object.keys(p.stages);
  return {
    pipelineId: p.pipelineId,
    stages: p.stages,
    stageNames,
    stageIdFor: (name: string) => p.stages[name],
    stageRank: (name: string | null) => (name ? stageNames.indexOf(name) : -1),
  };
}

/**
 * Create a deal, retrying once without our custom fields if the first attempt
 * fails — so a custom-field rejection (e.g. unknown deal-field key, or a field
 * the token can't write) can't block every deal. The stamped ids on the frame
 * records remain the primary dedup key, so dropping the custom fields only
 * weakens the secondary search-based linkage.
 */
async function createDealSafe(body: Record<string, unknown>, customFieldKeys: string[]): Promise<PdCreated> {
  try {
    return await createDeal(body as { title: string });
  } catch (e) {
    const cf = customFieldKeys.filter(Boolean);
    if (cf.length === 0) throw e;
    const stripped = { ...body };
    let had = false;
    for (const k of cf) {
      if (k in stripped) {
        delete stripped[k];
        had = true;
      }
    }
    if (!had) throw e;
    console.warn("[pipedrive-sync] deal create failed with custom fields, retrying without:", e instanceof Error ? e.message : e);
    return await createDeal(stripped as { title: string });
  }
}

// ── outreach deal (interest edge) ───────────────────────────────────────────

export interface OutreachResult {
  companyId: string;
  pipeline: "ajm" | "catalog";
  dealId: number | null;
  action: "created" | "advanced" | "noop" | "skipped";
  reason?: string;
}

/**
 * Ensure an open outreach deal exists for a company at (at least) `stageName`.
 * One open deal per (company, pipeline): if one exists, advance it forward to
 * the target stage; never create a second. Used by the interest edge and the
 * AJM seed (seed targets the pipeline's first stage).
 */
export async function ensureOutreachDeal(
  companyId: string,
  pipeline: "ajm" | "catalog",
  stageName: string,
  opts: { dryRun?: boolean } = {},
): Promise<OutreachResult> {
  const { config, ownerId } = requireConfig();
  const meta = pipelineMeta(config, pipeline);
  const targetStageId = meta.stageIdFor(stageName);
  if (!targetStageId) {
    return { companyId, pipeline, dealId: null, action: "skipped", reason: `unknown stage "${stageName}"` };
  }

  const existing = findOpenDealInPipeline(companyId, pipeline);
  if (existing) {
    const curRank = meta.stageRank(existing.stage);
    const tgtRank = meta.stageRank(stageName);
    if (tgtRank > curRank) {
      if (!opts.dryRun) {
        await updateDeal(existing.pipedrive_deal_id!, { stage_id: targetStageId });
        sqlite
          .prepare("UPDATE pipedrive_deals SET stage = ?, updated_at = datetime('now') WHERE pipedrive_deal_id = ?")
          .run(stageName, existing.pipedrive_deal_id);
      }
      return { companyId, pipeline, dealId: existing.pipedrive_deal_id, action: "advanced" };
    }
    return { companyId, pipeline, dealId: existing.pipedrive_deal_id, action: "noop" };
  }

  if (opts.dryRun) return { companyId, pipeline, dealId: null, action: "created", reason: "dry-run" };

  const c = getCompany(companyId);
  const keys = await ensureCustomFields();
  const orgId = await resolveOrg(companyId, ownerId);
  const personId = await resolvePerson(companyId, orgId, ownerId);
  const title = `${c?.name || "Company"} — ${pipeline === "ajm" ? "AJM reactivation" : "catalog interest"}`;
  const body: Record<string, unknown> = {
    title,
    org_id: orgId,
    pipeline_id: meta.pipelineId,
    stage_id: targetStageId,
    status: "open",
  };
  if (keys.dealFrameCompanyId) body[keys.dealFrameCompanyId] = companyId;
  if (personId) body.person_id = personId;
  if (ownerId) body.user_id = ownerId; // deals use user_id for the owner (not owner_id)
  const created = await createDealSafe(body, [keys.dealFrameCompanyId]);
  upsertProjection({
    pipedriveDealId: created.id,
    companyId,
    pipeline,
    stage: stageName,
    status: "open",
    title,
  });
  return { companyId, pipeline, dealId: created.id, action: "created" };
}

// ── AJM seed ────────────────────────────────────────────────────────────────

export interface SeedResult {
  scanned: number;
  created: number;
  existing: number;
  skipped: number;
  errors: Array<{ companyId: string; error: string }>;
  dryRun: boolean;
}

/**
 * Seed the curated AJM cohort (tagged `ajm_pipedrive_push`) into AJM
 * Reactivation at the "To Contact" stage, owned by Christina. Idempotent:
 * companies that already have an open AJM deal are left alone.
 */
export async function seedAjmToPipedrive(opts: { limit?: number; dryRun?: boolean } = {}): Promise<SeedResult> {
  requireConfig();
  const dryRun = opts.dryRun ?? false;
  const rows = sqlite
    .prepare(
      `SELECT id FROM companies
        WHERE tags LIKE '%ajm_pipedrive_push%'
        ORDER BY ajm_total_spend DESC NULLS LAST
        ${opts.limit ? "LIMIT " + Math.max(1, Math.floor(opts.limit)) : ""}`,
    )
    .all() as Array<{ id: string }>;

  const result: SeedResult = { scanned: rows.length, created: 0, existing: 0, skipped: 0, errors: [], dryRun };
  for (const { id } of rows) {
    try {
      const r = await ensureOutreachDeal(id, "ajm", "To Contact", { dryRun });
      if (r.action === "created") result.created++;
      else if (r.action === "noop" || r.action === "advanced") result.existing++;
      else result.skipped++;
    } catch (e) {
      if (e instanceof PipedriveNotReadyError) throw e;
      result.errors.push({ companyId: id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

// ── interested backfill ─────────────────────────────────────────────────────

export interface BackfillInterestedResult {
  scanned: number;
  ajmAdvanced: number;
  catalogCreated: number;
  noop: number;
  skipped: number;
  errors: Array<{ companyId: string; error: string }>;
  dryRun: boolean;
}

/**
 * One-time backfill of the existing interested/catalog_sent backlog (docs
 * §3.3). AJM contacts route to AJM Reactivation (their seeded deal advances to
 * Interested); non-AJM interested leads create a Catalog Interested deal.
 */
export async function backfillInterested(opts: { dryRun?: boolean } = {}): Promise<BackfillInterestedResult> {
  requireConfig();
  const dryRun = opts.dryRun ?? false;
  const rows = sqlite
    .prepare(
      `SELECT id, name, pipedrive_org_id, pipedrive_person_id, source, tags, status
         FROM companies WHERE status IN ('interested','catalog_sent')`,
    )
    .all() as CompanyRow[];

  const result: BackfillInterestedResult = {
    scanned: rows.length,
    ajmAdvanced: 0,
    catalogCreated: 0,
    noop: 0,
    skipped: 0,
    errors: [],
    dryRun,
  };

  for (const c of rows) {
    try {
      const isAjm = isAjmCompany(c);
      const pipeline: "ajm" | "catalog" = isAjm ? "ajm" : "catalog";
      // AJM reactivation is a call queue — its deals stay at "To Contact"
      // (Christina advances them manually), never auto-bumped to Interested.
      // Non-AJM: catalog_sent → "Catalog Sent", else "Interested".
      const stageName = isAjm ? "To Contact" : c.status === "catalog_sent" ? "Catalog Sent" : "Interested";
      const r = await ensureOutreachDeal(c.id, pipeline, stageName, { dryRun });
      if (r.action === "created") {
        if (isAjm) result.ajmAdvanced++;
        else result.catalogCreated++;
      } else if (r.action === "advanced") {
        result.ajmAdvanced++;
      } else if (r.action === "noop") {
        result.noop++;
      } else {
        result.skipped++;
      }
    } catch (e) {
      if (e instanceof PipedriveNotReadyError) throw e;
      result.errors.push({ companyId: c.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

// ── order → deal (order edge) ───────────────────────────────────────────────

interface OrderRow {
  id: string;
  company_id: string | null;
  channel: string;
  status: string;
  total: number;
  currency: string;
  placed_at: string | null;
  created_at: string | null;
  order_number: string | null;
  pipedrive_deal_id: number | null;
}

function getOrder(orderId: string): OrderRow | undefined {
  return sqlite
    .prepare(
      `SELECT id, company_id, channel, status, total, currency, placed_at, created_at, order_number, pipedrive_deal_id
         FROM orders WHERE id = ?`,
    )
    .get(orderId) as OrderRow | undefined;
}

/** Pipedrive want "YYYY-MM-DD HH:MM:SS" (UTC) for won_time/add_time. */
function pdDateTime(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export interface OrderDealResult {
  orderId: string;
  dealId: number | null;
  action: "won_existing" | "created_won" | "already_synced" | "skipped";
  reason?: string;
}

/**
 * Represent a wholesale order as exactly one Won deal (docs §7): if the org
 * already has an open outreach deal, win that one (report the order under it);
 * otherwise create a fresh Won deal in Customers. Idempotent on
 * orders.pipedrive_deal_id and the deal's frame_order_id custom field.
 */
export async function createDealForOrder(
  orderId: string,
  opts: { dryRun?: boolean; backfillRunId?: string } = {},
): Promise<OrderDealResult> {
  const { config, ownerId } = requireConfig();
  const order = getOrder(orderId);
  if (!order) return { orderId, dealId: null, action: "skipped", reason: "order not found" };
  if (order.pipedrive_deal_id) return { orderId, dealId: order.pipedrive_deal_id, action: "already_synced" };
  if (order.channel !== "shopify_wholesale") {
    return { orderId, dealId: null, action: "skipped", reason: `channel ${order.channel} not wholesale` };
  }
  if (order.status === "cancelled") return { orderId, dealId: null, action: "skipped", reason: "cancelled" };
  if (!order.company_id) return { orderId, dealId: null, action: "skipped", reason: "no company" };

  const dryRun = opts.dryRun ?? false;
  const wonTime = pdDateTime(order.placed_at || order.created_at);

  // Win an existing open outreach deal if the org has one.
  const open = findAnyOpenDeal(order.company_id);
  if (open?.pipedrive_deal_id) {
    if (dryRun) return { orderId, dealId: open.pipedrive_deal_id, action: "won_existing", reason: "dry-run" };
    const keys = await ensureCustomFields();
    const winBody: Record<string, unknown> = {
      status: "won",
      value: order.total,
      currency: order.currency || "USD",
      won_time: wonTime,
    };
    if (keys.dealFrameOrderId) winBody[keys.dealFrameOrderId] = orderId;
    await updateDeal(open.pipedrive_deal_id, winBody);
    sqlite
      .prepare(
        "UPDATE pipedrive_deals SET status='won', is_open=0, value=?, order_id=?, updated_at=datetime('now') WHERE pipedrive_deal_id = ?",
      )
      .run(order.total, orderId, open.pipedrive_deal_id);
    sqlite.prepare("UPDATE orders SET pipedrive_deal_id = ? WHERE id = ?").run(open.pipedrive_deal_id, orderId);
    return { orderId, dealId: open.pipedrive_deal_id, action: "won_existing" };
  }

  if (dryRun) return { orderId, dealId: null, action: "created_won", reason: "dry-run" };

  // Else create a standalone Won deal in Customers.
  const keys = await ensureCustomFields();
  const meta = pipelineMeta(config, "customers");
  const stageName = meta.stageNames[0]; // "Order Placed"
  const orgId = await resolveOrg(order.company_id, ownerId);
  const personId = await resolvePerson(order.company_id, orgId, ownerId);
  const c = getCompany(order.company_id);
  const title = `${c?.name || "Customer"} — order ${order.order_number || ""}`.trim();
  const body: Record<string, unknown> = {
    title,
    org_id: orgId,
    pipeline_id: meta.pipelineId,
    stage_id: meta.stageIdFor(stageName),
    status: "won",
    value: order.total,
    currency: order.currency || "USD",
    won_time: wonTime,
  };
  if (keys.dealFrameCompanyId) body[keys.dealFrameCompanyId] = order.company_id;
  if (keys.dealFrameOrderId) body[keys.dealFrameOrderId] = orderId;
  if (personId) body.person_id = personId;
  if (ownerId) body.user_id = ownerId; // deals use user_id for the owner (not owner_id)
  if (opts.backfillRunId && keys.dealBackfillRunId) body[keys.dealBackfillRunId] = opts.backfillRunId;
  const created = await createDealSafe(body, [keys.dealFrameCompanyId, keys.dealFrameOrderId, keys.dealBackfillRunId]);
  upsertProjection({
    pipedriveDealId: created.id,
    companyId: order.company_id,
    orderId,
    pipeline: "customers",
    stage: stageName,
    status: "won",
    value: order.total,
    title,
    backfillRunId: opts.backfillRunId,
  });
  sqlite.prepare("UPDATE orders SET pipedrive_deal_id = ? WHERE id = ?").run(created.id, orderId);
  return { orderId, dealId: created.id, action: "created_won" };
}

// ── order-deal backfill / sweep ─────────────────────────────────────────────

export interface OrderBackfillResult {
  scanned: number;
  wonExisting: number;
  createdWon: number;
  alreadySynced: number;
  skipped: number;
  errors: Array<{ orderId: string; error: string }>;
  dryRun: boolean;
  backfillRunId?: string;
}

/**
 * Backfill historical wholesale orders → Won deals. Idempotent on
 * orders.pipedrive_deal_id; backfill-created deals are tagged with
 * `backfillRunId` so a run is cleanly reversible (docs §9.3).
 */
export async function backfillOrderDeals(
  opts: { dryRun?: boolean; limit?: number; backfillRunId?: string; sinceDays?: number } = {},
): Promise<OrderBackfillResult> {
  requireConfig();
  const dryRun = opts.dryRun ?? false;
  // sinceDays scopes the sweep to recent orders (go-forward coverage). Omit
  // for a full historical backfill (manual, sign-off-gated — docs §9.3).
  const sinceClause = opts.sinceDays
    ? `AND COALESCE(placed_at, created_at) >= datetime('now', '-${Math.max(1, Math.floor(opts.sinceDays))} days')`
    : "";
  const rows = sqlite
    .prepare(
      `SELECT id FROM orders
        WHERE channel = 'shopify_wholesale' AND status != 'cancelled' AND pipedrive_deal_id IS NULL
        ${sinceClause}
        ORDER BY placed_at DESC
        ${opts.limit ? "LIMIT " + Math.max(1, Math.floor(opts.limit)) : ""}`,
    )
    .all() as Array<{ id: string }>;

  const result: OrderBackfillResult = {
    scanned: rows.length,
    wonExisting: 0,
    createdWon: 0,
    alreadySynced: 0,
    skipped: 0,
    errors: [],
    dryRun,
    backfillRunId: opts.backfillRunId,
  };
  for (const { id } of rows) {
    try {
      const r = await createDealForOrder(id, { dryRun, backfillRunId: opts.backfillRunId });
      if (r.action === "won_existing") result.wonExisting++;
      else if (r.action === "created_won") result.createdWon++;
      else if (r.action === "already_synced") result.alreadySynced++;
      else result.skipped++;
    } catch (e) {
      if (e instanceof PipedriveNotReadyError) throw e;
      result.errors.push({ orderId: id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

/**
 * Cron entry point: sweep recent wholesale orders into Won deals. No-ops
 * silently when Pipedrive isn't connected/provisioned so the job is safe to
 * leave scheduled. Scoped to a recent window — the full historical backfill is
 * a separate, sign-off-gated admin action.
 */
export async function runOrderDealSweep(sinceDays = 14): Promise<unknown> {
  if (!isSyncEnabled()) return { skipped: "pipedrive sync disabled" };
  if (!getPipedriveConnectionStatus().connected || !getPipelineConfig()) {
    return { skipped: "pipedrive not configured" };
  }
  return backfillOrderDeals({ sinceDays });
}

// ── background runner (click-to-run from the settings page) ─────────────────

export type RunTarget = "seed-ajm" | "backfill-interested" | "backfill-orders";
const RUN_TARGETS: RunTarget[] = ["seed-ajm", "backfill-interested", "backfill-orders"];
const inFlight = new Set<string>();

function setRunState(target: string, state: Record<string, unknown>): void {
  setSetting(`pipedrive_run_${target}`, JSON.stringify({ ...state, at: new Date().toISOString() }));
}
export function getRunState(target: string): Record<string, unknown> | null {
  const raw = getSetting(`pipedrive_run_${target}`);
  if (!raw) return null;
  try {
    return { ...(JSON.parse(raw) as Record<string, unknown>), inFlight: inFlight.has(target) };
  } catch {
    return null;
  }
}
export function getAllRunStates(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const t of RUN_TARGETS) out[t] = getRunState(t);
  return out;
}

/**
 * Kick a real (non-dry) push as a detached background task. Returns
 * immediately; progress/result land in settings (poll via getRunState). The
 * Node process keeps running the work after the HTTP response — the same
 * fire-and-forget approach the long cron jobs use. Idempotent functions mean a
 * mid-run restart is recovered by clicking again.
 */
export function kickBackgroundRun(target: RunTarget): { started: boolean; alreadyRunning?: boolean; error?: string } {
  if (inFlight.has(target)) return { started: false, alreadyRunning: true };
  if (!getPipedriveConnectionStatus().connected || !getPipelineConfig()) {
    setRunState(target, { state: "error", error: "pipedrive not configured" });
    return { started: false, error: "pipedrive not configured" };
  }
  inFlight.add(target);
  setRunState(target, { state: "running" });
  void (async () => {
    try {
      let summary: unknown;
      if (target === "seed-ajm") summary = await seedAjmToPipedrive({});
      else if (target === "backfill-interested") summary = await backfillInterested({});
      else summary = await backfillOrderDeals({ backfillRunId: new Date().toISOString().slice(0, 10) });
      setRunState(target, { state: "done", summary });
    } catch (e) {
      setRunState(target, { state: "error", error: e instanceof Error ? e.message : String(e) });
    } finally {
      inFlight.delete(target);
    }
  })();
  return { started: true };
}

// ── status fan-out job (go-forward interest edge) ───────────────────────────

/**
 * Map a frame status to a Pipedrive outreach action. Called by the
 * `sales.sync_status_to_pipedrive` job handler. customer/order is handled by
 * the order edge (createDealForOrder), not here.
 */
export async function syncStatusToPipedrive(
  companyId: string,
  status: string,
): Promise<Record<string, unknown>> {
  // Skip silently when sync is off or Pipedrive isn't set up so the fan-out
  // never throws (and never auto-creates deals before sign-off).
  if (!isSyncEnabled()) return { skipped: "pipedrive sync disabled" };
  if (!getPipedriveConnectionStatus().connected || !getPipelineConfig()) {
    return { skipped: "pipedrive not configured" };
  }
  const c = getCompany(companyId);
  if (!c) return { skipped: "company not found" };

  if (status === "interested" || status === "catalog_sent") {
    const isAjm = isAjmCompany(c);
    const pipeline: "ajm" | "catalog" = isAjm ? "ajm" : "catalog";
    // AJM reactivation deals stay at "To Contact" (call queue) — never
    // auto-advanced. Non-AJM advance with the frame status.
    const stageName = isAjm ? "To Contact" : status === "catalog_sent" ? "Catalog Sent" : "Interested";
    const r = await ensureOutreachDeal(companyId, pipeline, stageName);
    return { ...r };
  }
  // interested_later / not_interested / ghosted → mark the open outreach deal Lost.
  if (status === "revisit_later" || status === "not_interested" || status === "ghosted") {
    const open = findAnyOpenDeal(companyId);
    if (open?.pipedrive_deal_id) {
      await updateDeal(open.pipedrive_deal_id, { status: "lost" });
      sqlite
        .prepare("UPDATE pipedrive_deals SET status='lost', is_open=0, updated_at=datetime('now') WHERE pipedrive_deal_id = ?")
        .run(open.pipedrive_deal_id);
      return { ok: true, lost: open.pipedrive_deal_id };
    }
    return { skipped: "no open deal to lose" };
  }
  return { skipped: `status ${status} not mapped` };
}

export { PipedriveError };
