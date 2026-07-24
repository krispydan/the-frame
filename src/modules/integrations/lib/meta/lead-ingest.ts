/**
 * Meta Lead Ads ingestion: leadgen webhook / reconciliation poll → the frame.
 *
 * Flow per lead:
 *   1. recordLeadgenEvent()  — INSERT OR IGNORE the leadgen_id (idempotent;
 *      Meta retries webhook deliveries and the poll re-sees the same leads).
 *   2. processMetaLead()     — fetch the full submission, parse contact fields,
 *      dedupe→find-or-create the company, store parsed fields, push to
 *      Pipedrive, queue the CAPI "Lead" event, and Slack-notify.
 *   3. drainMetaLeads()      — cron: process any still-"received" rows.
 *   4. reconcileMetaLeads()  — cron: re-poll known forms as a safety net for
 *      dropped webhooks.
 *
 * Never throws out of the webhook path — a fetch/Pipedrive failure marks the
 * row "error" for retry, it doesn't 500 the webhook.
 */

import { sqlite } from "@/lib/db";
import { addCompanyEmail } from "@/modules/sales/lib/company-emails";
import { addCompanyPhone } from "@/modules/sales/lib/company-phones";
import { fetchLead, fetchFormLeads, metaLeadsConfigured, type MetaLeadDetail, type MetaLeadField } from "./client";
import { pushFacebookLeadToPipedrive, dealUrl } from "./pipedrive-push";
import { queueCapiEvent } from "./capi";

// ── field parsing ──

/** Case/format-insensitive lookup across a Meta field_data array. */
function fieldValue(fields: MetaLeadField[], ...names: string[]): string | null {
  const want = new Set(names.map((n) => n.toLowerCase().replace(/[^a-z0-9]/g, "")));
  for (const f of fields) {
    const key = (f.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (want.has(key)) {
      const v = (f.values || []).find((x) => x && x.trim());
      if (v) return v.trim();
    }
  }
  return null;
}

interface ParsedLead {
  email: string | null;
  phone: string | null;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}

function parseLead(detail: MetaLeadDetail): ParsedLead {
  const f = detail.field_data || [];
  const email = fieldValue(f, "email", "work_email", "email_address");
  const phone = fieldValue(f, "phone_number", "phone", "work_phone_number", "mobile");
  let firstName = fieldValue(f, "first_name", "firstname");
  let lastName = fieldValue(f, "last_name", "lastname");
  const fullName = fieldValue(f, "full_name", "name") || [firstName, lastName].filter(Boolean).join(" ").trim() || null;
  if (!firstName && !lastName && fullName) {
    const parts = fullName.split(/\s+/);
    firstName = parts[0] || null;
    lastName = parts.length > 1 ? parts.slice(1).join(" ") : null;
  }
  const companyName = fieldValue(f, "company_name", "company", "business_name", "store_name");
  return { email, phone, fullName: fullName || null, firstName, lastName, companyName };
}

// ── dedupe / company resolution ──

function findCompanyByEmail(email: string): string | null {
  const r = sqlite
    .prepare(
      `SELECT c.id FROM contacts ct JOIN companies c ON c.id = ct.company_id
        WHERE LOWER(TRIM(ct.email)) = LOWER(TRIM(?)) LIMIT 1`,
    )
    .get(email) as { id: string } | undefined;
  return r?.id ?? null;
}

function findCompanyByPhone(phone: string): string | null {
  const digits = phone.replace(/[^\d]/g, "");
  if (digits.length < 7) return null;
  const last7 = digits.slice(-7);
  const r = sqlite
    .prepare(
      `SELECT company_id FROM company_phones
        WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone,'-',''),' ',''),'(',''),')','') LIKE ?
        ORDER BY is_primary DESC LIMIT 1`,
    )
    .get(`%${last7}`) as { company_id: string } | undefined;
  return r?.company_id ?? null;
}

/** Resolve to an existing company (email → phone) or create a new prospect. */
function resolveCompany(parsed: ParsedLead): { companyId: string; created: boolean } {
  if (parsed.email) {
    const byEmail = findCompanyByEmail(parsed.email);
    if (byEmail) return { companyId: byEmail, created: false };
  }
  if (parsed.phone) {
    const byPhone = findCompanyByPhone(parsed.phone);
    if (byPhone) return { companyId: byPhone, created: false };
  }
  const name =
    parsed.companyName ||
    parsed.fullName ||
    (parsed.email ? parsed.email.split("@")[0] : null) ||
    "Facebook lead";
  const id = crypto.randomUUID();
  sqlite
    .prepare(
      `INSERT INTO companies (id, name, type, status, source, source_type, created_at, updated_at)
       VALUES (?, ?, 'online', 'prospect', 'facebook_leads', 'facebook_leads', datetime('now'), datetime('now'))`,
    )
    .run(id, name);
  return { companyId: id, created: true };
}

/** Set the primary contact's name if we learned it (don't clobber an existing name). */
function applyContactName(companyId: string, parsed: ParsedLead): void {
  if (!parsed.firstName && !parsed.lastName) return;
  const primary = sqlite
    .prepare("SELECT id, first_name, last_name FROM contacts WHERE company_id = ? ORDER BY is_primary DESC, created_at ASC LIMIT 1")
    .get(companyId) as { id: string; first_name: string | null; last_name: string | null } | undefined;
  if (primary) {
    if (!(primary.first_name || "").trim() && !(primary.last_name || "").trim()) {
      sqlite.prepare("UPDATE contacts SET first_name = ?, last_name = ?, updated_at = datetime('now') WHERE id = ?")
        .run(parsed.firstName, parsed.lastName, primary.id);
    }
  } else {
    sqlite
      .prepare(
        `INSERT INTO contacts (id, company_id, first_name, last_name, is_primary, source, created_at, updated_at)
         VALUES (lower(hex(randomblob(16))), ?, ?, ?, 1, 'facebook_leads', datetime('now'), datetime('now'))`,
      )
      .run(companyId, parsed.firstName, parsed.lastName);
  }
}

// ── ingestion ──

export interface LeadgenEntry {
  leadgenId: string;
  formId?: string | null;
  pageId?: string | null;
  createdTime?: string | null;
}

/**
 * Record a raw leadgen event (idempotent). Returns true if a NEW row was
 * inserted (i.e. not a duplicate delivery). Also remembers the form id so the
 * reconciliation cron knows which forms to poll.
 */
export function recordLeadgenEvent(entry: LeadgenEntry): boolean {
  const inserted = sqlite
    .prepare(
      `INSERT OR IGNORE INTO meta_leads (id, leadgen_id, form_id, page_id, created_time, status)
       VALUES (?, ?, ?, ?, ?, 'received')`,
    )
    .run(crypto.randomUUID(), entry.leadgenId, entry.formId ?? null, entry.pageId ?? null, entry.createdTime ?? null).changes;
  if (entry.formId) rememberForm(entry.formId);
  return inserted > 0;
}

function rememberForm(formId: string): void {
  const raw = sqlite.prepare("SELECT value FROM settings WHERE key = 'meta_known_forms'").get() as { value: string | null } | undefined;
  let forms: string[] = [];
  try { forms = raw?.value ? (JSON.parse(raw.value) as string[]) : []; } catch { forms = []; }
  if (!forms.includes(formId)) {
    forms.push(formId);
    sqlite
      .prepare(
        `INSERT INTO settings (key, value, type, module, updated_at)
         VALUES ('meta_known_forms', ?, 'json', 'integrations', datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      )
      .run(JSON.stringify(forms));
  }
}

export function getKnownForms(): string[] {
  const raw = sqlite.prepare("SELECT value FROM settings WHERE key = 'meta_known_forms'").get() as { value: string | null } | undefined;
  try { return raw?.value ? (JSON.parse(raw.value) as string[]) : []; } catch { return []; }
}

export interface ProcessResult {
  leadgenId: string;
  status: "processed" | "skipped" | "error" | "already";
  companyId?: string;
  companyCreated?: boolean;
  dealId?: number | null;
  reason?: string;
}

/**
 * Fetch + fully process a single leadgen_id. Idempotent: a row already marked
 * processed is a no-op. On any failure the row is marked "error" (with the
 * message) for a later retry — it never throws.
 */
export async function processMetaLead(leadgenId: string, detailOverride?: MetaLeadDetail): Promise<ProcessResult> {
  const row = sqlite.prepare("SELECT id, status FROM meta_leads WHERE leadgen_id = ?").get(leadgenId) as
    | { id: string; status: string }
    | undefined;
  if (row?.status === "processed") return { leadgenId, status: "already", reason: "already processed" };
  const metaLeadRowId = row?.id ?? null;

  try {
    const detail = detailOverride ?? (await fetchLead(leadgenId));
    if (!detail) {
      markError(leadgenId, "could not fetch lead from Graph API");
      return { leadgenId, status: "error", reason: "fetch failed" };
    }

    const parsed = parseLead(detail);
    const { companyId, created } = resolveCompany(parsed);

    if (parsed.email) addCompanyEmail(companyId, parsed.email, "facebook_leads");
    if (parsed.phone) addCompanyPhone(companyId, parsed.phone, "facebook_leads");
    applyContactName(companyId, parsed);

    // Persist parsed fields + attribution onto the meta_leads row.
    sqlite
      .prepare(
        `UPDATE meta_leads
            SET form_id = COALESCE(?, form_id), campaign_name = ?, adset_name = ?, ad_name = ?,
                field_data = ?, full_name = ?, email = ?, phone = ?, company_id = ?,
                created_time = COALESCE(?, created_time), status = 'processed', error = NULL,
                processed_at = datetime('now')
          WHERE leadgen_id = ?`,
      )
      .run(
        detail.form_id ?? null,
        detail.campaign_name ?? null,
        (detail as { adset_name?: string }).adset_name ?? null,
        detail.ad_name ?? null,
        JSON.stringify(detail.field_data ?? []),
        parsed.fullName,
        parsed.email,
        parsed.phone,
        companyId,
        detail.created_time ?? null,
        leadgenId,
      );
    if (detail.form_id) rememberForm(detail.form_id);

    const finalRowId =
      metaLeadRowId ??
      (sqlite.prepare("SELECT id FROM meta_leads WHERE leadgen_id = ?").get(leadgenId) as { id: string }).id;

    // Push to Pipedrive (best-effort — a Pipedrive outage shouldn't lose the lead).
    let push = null;
    try {
      push = await pushFacebookLeadToPipedrive({
        metaLeadId: finalRowId,
        companyId,
        contactName: parsed.fullName,
        campaignName: detail.campaign_name ?? null,
        adsetName: (detail as { adset_name?: string }).adset_name ?? null,
        adName: detail.ad_name ?? null,
        formId: detail.form_id ?? null,
        fieldData: detail.field_data ?? null,
      });
    } catch (e) {
      console.warn("[meta] pipedrive push failed (non-fatal):", e instanceof Error ? e.message : e);
    }

    // Queue the CAPI "Lead" event back to Meta (idempotent).
    queueCapiEvent({
      metaLeadId: finalRowId,
      leadgenId,
      companyId,
      eventName: "Lead",
      email: parsed.email,
      phone: parsed.phone,
      eventTime: detail.created_time ? Math.floor(new Date(detail.created_time).getTime() / 1000) : undefined,
    });

    // Slack notify (best-effort).
    try {
      const { notifyFacebookLead } = await import("@/modules/integrations/lib/slack/notifications");
      const base = (process.env.SHOPIFY_APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
      await notifyFacebookLead({
        contactName: parsed.fullName,
        companyName: parsed.companyName,
        email: parsed.email,
        phone: parsed.phone,
        campaignName: detail.campaign_name ?? null,
        adName: detail.ad_name ?? null,
        formName: detail.form_id ?? null,
        source: "Facebook/Instagram",
        frameUrl: base ? `${base}/prospects/${companyId}` : null,
        pipedriveDealUrl: push?.dealId ? dealUrl(push.dealId) : null,
        matchedExisting: !created,
      });
    } catch (e) {
      console.warn("[meta] slack notify failed (non-fatal):", e instanceof Error ? e.message : e);
    }

    return { leadgenId, status: "processed", companyId, companyCreated: created, dealId: push?.dealId ?? null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    markError(leadgenId, msg);
    return { leadgenId, status: "error", reason: msg };
  }
}

function markError(leadgenId: string, error: string): void {
  sqlite.prepare("UPDATE meta_leads SET status = 'error', error = ? WHERE leadgen_id = ?").run(error.slice(0, 500), leadgenId);
}

/** Cron: process still-"received" (or previously errored) leads. */
export async function drainMetaLeads(limit = 25): Promise<{ processed: number; errors: number; skipped: number }> {
  if (!metaLeadsConfigured()) return { processed: 0, errors: 0, skipped: 0 };
  const rows = sqlite
    .prepare("SELECT leadgen_id FROM meta_leads WHERE status IN ('received','error') ORDER BY created_at ASC LIMIT ?")
    .all(limit) as Array<{ leadgen_id: string }>;
  let processed = 0, errors = 0, skipped = 0;
  for (const r of rows) {
    const res = await processMetaLead(r.leadgen_id);
    if (res.status === "processed") processed++;
    else if (res.status === "error") errors++;
    else skipped++;
  }
  return { processed, errors, skipped };
}

/** Cron safety-net: re-poll known forms for leads the webhook may have dropped. */
export async function reconcileMetaLeads(perForm = 50): Promise<{ forms: number; newLeads: number; processed: number }> {
  if (!metaLeadsConfigured()) return { forms: 0, newLeads: 0, processed: 0 };
  const forms = getKnownForms();
  let newLeads = 0, processed = 0;
  for (const formId of forms) {
    const leads = await fetchFormLeads(formId, perForm);
    for (const lead of leads) {
      const isNew = recordLeadgenEvent({ leadgenId: lead.id, formId, createdTime: lead.created_time ?? null });
      if (isNew) newLeads++;
      // Process directly with the detail we already have (saves a fetch).
      const res = await processMetaLead(lead.id, lead);
      if (res.status === "processed") processed++;
    }
  }
  return { forms: forms.length, newLeads, processed };
}
