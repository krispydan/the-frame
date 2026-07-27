/**
 * Facebook-lead → Pipedrive push.
 *
 * These land in Pipedrive's **Leads Inbox**, not the deal pipeline. An ad
 * submission is an unqualified enquiry — nobody has spoken to them, there's no
 * agreed value and no close date. Creating a deal for each one inflates
 * pipeline value, skews forecast and conversion reporting, and buries the reps'
 * real opportunities under untouched form fills. A rep qualifies the lead in
 * the inbox and converts it to a deal when it becomes real; that conversion is
 * also the honest "Qualified" signal we report back to Meta's CAPI.
 *
 * Reuses the generic, dedup-safe org/person resolvers from pipedrive-sync (they
 * key on the frame company id and stamp companies.pipedrive_org_id /
 * pipedrive_person_id), then creates the lead with a "Facebook Ads" label and
 * attaches the ad attribution + raw form answers as a note.
 */

import { sqlite } from "@/lib/db";
import {
  pdRequest,
  listPipelines,
  listStages,
  createLead,
  ensureLeadLabel,
  createNote,
  getPipedriveConnectionStatus,
} from "@/modules/sales/lib/pipedrive-client";
import { resolveOrg, resolvePerson } from "@/modules/sales/lib/pipedrive-sync";
import { getPipedriveOwner } from "@/modules/sales/lib/pipedrive-setup";

const PIPELINE_NAME = "Facebook Leads";
const STAGES = ["New Lead", "Contacted", "Qualified", "Won"];
const SETTING_KEY = "pipedrive_facebook_pipeline";
const LABEL_NAME = "Facebook Ads";
const LABEL_SETTING_KEY = "pipedrive_facebook_lead_label";

interface FacebookPipelineConfig {
  pipelineId: number;
  stages: Record<string, number>;
}

function getSetting(key: string): string | null {
  const r = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string | null } | undefined;
  return r?.value ?? null;
}
function setSetting(key: string, value: string): void {
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, type, module, updated_at)
       VALUES (?, ?, 'string', 'integrations', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(key, value);
}

export function getFacebookPipelineConfig(): FacebookPipelineConfig | null {
  const raw = getSetting(SETTING_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FacebookPipelineConfig;
  } catch {
    return null;
  }
}

/**
 * The deal pipeline reps convert qualified Facebook leads INTO. No longer used
 * on the inbound path — leads go to the Leads Inbox — but kept so the pipeline
 * exists as a destination and the settings UI can still report it.
 */
export async function ensureFacebookPipeline(): Promise<FacebookPipelineConfig> {
  const existingPipelines = await listPipelines();
  let pipeline = existingPipelines.find((p) => p.name.trim().toLowerCase() === PIPELINE_NAME.toLowerCase());
  if (!pipeline) {
    const created = await pdRequest<{ id: number; name: string }>("POST", "/pipelines", { name: PIPELINE_NAME });
    pipeline = { id: created.id, name: PIPELINE_NAME };
  }
  const pipelineId = pipeline.id;

  const existingStages = await listStages();
  const stages: Record<string, number> = {};
  let order = 1;
  for (const stageName of STAGES) {
    let stage = existingStages.find(
      (s) => s.pipeline_id === pipelineId && s.name.trim().toLowerCase() === stageName.toLowerCase(),
    );
    if (!stage) {
      const created = await pdRequest<{ id: number }>("POST", "/stages", {
        name: stageName,
        pipeline_id: pipelineId,
        order_nr: order,
      });
      stage = { id: created.id, name: stageName, pipeline_id: pipelineId, order_nr: order };
    }
    stages[stageName] = stage.id;
    order++;
  }

  const config = { pipelineId, stages };
  setSetting(SETTING_KEY, JSON.stringify(config));
  return config;
}

/** Find-or-create the "Facebook Ads" lead label, cached so we don't re-list. */
async function facebookLabelId(): Promise<string | null> {
  const cached = getSetting(LABEL_SETTING_KEY);
  if (cached) return cached;
  try {
    const label = await ensureLeadLabel(LABEL_NAME, "blue");
    setSetting(LABEL_SETTING_KEY, label.id);
    return label.id;
  } catch (e) {
    // A missing label is cosmetic — never block the lead itself over it.
    console.warn("[meta/pipedrive] lead label ensure failed (non-fatal):", e instanceof Error ? e.message : e);
    return null;
  }
}

export interface FacebookLeadForPush {
  metaLeadId: string;
  companyId: string;
  contactName: string | null;
  campaignName: string | null;
  adsetName: string | null;
  adName: string | null;
  formId: string | null;
  fieldData: Array<{ name: string; values: string[] }> | null;
}

export interface FacebookPushResult {
  /** Pipedrive lead UUID. */
  leadId: string | null;
  personId: number | null;
  orgId: number | null;
  action: "created" | "exists" | "skipped";
  leadUrl: string | null;
  reason?: string;
}

/** Build the note body: ad attribution + the raw form answers. */
function buildNote(lead: FacebookLeadForPush): string {
  const lines: string[] = ["<b>New Facebook/Instagram Lead Ad submission</b>"];
  const attribution = [
    lead.campaignName ? `Campaign: ${lead.campaignName}` : "",
    lead.adsetName ? `Ad set: ${lead.adsetName}` : "",
    lead.adName ? `Ad: ${lead.adName}` : "",
    lead.formId ? `Form: ${lead.formId}` : "",
  ].filter(Boolean);
  if (attribution.length) lines.push(attribution.join(" · "));
  if (lead.fieldData?.length) {
    lines.push("");
    for (const f of lead.fieldData) {
      const label = f.name.replace(/_/g, " ");
      lines.push(`<b>${label}:</b> ${(f.values || []).join(", ")}`);
    }
  }
  return lines.join("<br>");
}

/**
 * Push a Facebook lead into Pipedrive's Leads Inbox: resolve org + person
 * (dedup-safe), create the lead with the "Facebook Ads" label, and attach an
 * attribution note. Idempotent per meta_lead — a lead already stamped with a
 * Pipedrive lead id returns "exists" without creating a duplicate.
 */
export async function pushFacebookLeadToPipedrive(lead: FacebookLeadForPush): Promise<FacebookPushResult> {
  if (!getPipedriveConnectionStatus().connected) {
    return { leadId: null, personId: null, orgId: null, action: "skipped", leadUrl: null, reason: "pipedrive not connected" };
  }

  // Idempotency: already pushed?
  const existing = sqlite
    .prepare("SELECT pipedrive_lead_id, pipedrive_person_id FROM meta_leads WHERE id = ?")
    .get(lead.metaLeadId) as { pipedrive_lead_id: string | null; pipedrive_person_id: number | null } | undefined;
  if (existing?.pipedrive_lead_id) {
    return {
      leadId: existing.pipedrive_lead_id,
      personId: existing.pipedrive_person_id ?? null,
      orgId: null,
      action: "exists",
      leadUrl: leadUrl(existing.pipedrive_lead_id),
    };
  }

  const ownerId = getPipedriveOwner()?.id;
  const orgId = await resolveOrg(lead.companyId, ownerId);
  const personId = await resolvePerson(lead.companyId, orgId, ownerId);

  // Pipedrive rejects a lead with neither a person nor an organisation.
  if (!orgId && !personId) {
    return {
      leadId: null, personId: null, orgId: null, action: "skipped", leadUrl: null,
      reason: "could not resolve a Pipedrive org or person for this company",
    };
  }

  const company = sqlite.prepare("SELECT name FROM companies WHERE id = ?").get(lead.companyId) as { name: string | null } | undefined;
  const title = `${lead.contactName || company?.name || "Facebook lead"} — Facebook lead`;

  const labelId = await facebookLabelId();
  const body: Record<string, unknown> = { title };
  if (orgId) body.organization_id = orgId;
  if (personId) body.person_id = personId;
  if (ownerId) body.owner_id = ownerId;
  if (labelId) body.label_ids = [labelId];

  const created = await createLead(body as { title: string });

  // Attribution note (best-effort — a note failure shouldn't fail the push).
  try {
    await createNote({ content: buildNote(lead), lead_id: created.id, org_id: orgId ?? undefined });
  } catch (e) {
    console.warn("[meta/pipedrive] note create failed (non-fatal):", e instanceof Error ? e.message : e);
  }

  sqlite
    .prepare("UPDATE meta_leads SET pipedrive_lead_id = ?, pipedrive_person_id = ? WHERE id = ?")
    .run(created.id, personId ?? null, lead.metaLeadId);

  return { leadId: created.id, personId, orgId, action: "created", leadUrl: leadUrl(created.id) };
}

/** Deep link to a lead in the Pipedrive Leads Inbox. */
export function leadUrl(leadId: string | null): string | null {
  if (!leadId) return null;
  const apiDomain = (getPipedriveConnectionStatus().apiDomain || "").replace(/\/$/, "");
  return apiDomain ? `${apiDomain}/leads/inbox/${leadId}` : null;
}
