/**
 * Facebook-lead → Pipedrive push.
 *
 * Kept separate from the ajm/catalog `ensureOutreachDeal` engine (which is
 * tightly coupled to those two pipelines' stage configs). Facebook leads are a
 * distinct top-of-funnel source, so they get their own "Facebook Leads"
 * pipeline, provisioned idempotently and cached in settings.
 *
 * Reuses the generic, dedup-safe org/person resolvers from pipedrive-sync
 * (they key on the frame company id and stamp companies.pipedrive_org_id /
 * pipedrive_person_id), then creates a deal directly via the client and
 * mirrors it into `pipedrive_deals` so the frame's existing Pipedrive panels
 * render it.
 */

import { sqlite } from "@/lib/db";
import {
  pdRequest,
  listPipelines,
  listStages,
  createDeal,
  createNote,
  getPipedriveConnectionStatus,
} from "@/modules/sales/lib/pipedrive-client";
import { resolveOrg, resolvePerson } from "@/modules/sales/lib/pipedrive-sync";
import { getPipedriveOwner } from "@/modules/sales/lib/pipedrive-setup";

const PIPELINE_NAME = "Facebook Leads";
const STAGES = ["New Lead", "Contacted", "Qualified", "Won"];
const SETTING_KEY = "pipedrive_facebook_pipeline";

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
 * Create (idempotently) the Facebook Leads pipeline + its stages, matching
 * existing ones by case-insensitive name so a re-run never duplicates. Caches
 * the id map in settings. Safe to re-run.
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
  dealId: number | null;
  personId: number | null;
  orgId: number | null;
  action: "created" | "exists" | "skipped";
  dealUrl: string | null;
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
 * Push a Facebook lead into Pipedrive: resolve org + person (dedup-safe),
 * open a deal in Facebook Leads → New Lead, attach an attribution note, and
 * mirror the deal into pipedrive_deals. Idempotent per meta_lead — if this
 * lead already has a deal stamped, returns exists.
 */
export async function pushFacebookLeadToPipedrive(lead: FacebookLeadForPush): Promise<FacebookPushResult> {
  if (!getPipedriveConnectionStatus().connected) {
    return { dealId: null, personId: null, orgId: null, action: "skipped", dealUrl: null, reason: "pipedrive not connected" };
  }

  // Idempotency: already pushed?
  const existing = sqlite
    .prepare("SELECT pipedrive_deal_id, pipedrive_person_id FROM meta_leads WHERE id = ?")
    .get(lead.metaLeadId) as { pipedrive_deal_id: number | null; pipedrive_person_id: number | null } | undefined;
  if (existing?.pipedrive_deal_id) {
    return {
      dealId: existing.pipedrive_deal_id,
      personId: existing.pipedrive_person_id ?? null,
      orgId: null,
      action: "exists",
      dealUrl: dealUrl(existing.pipedrive_deal_id),
    };
  }

  const config = getFacebookPipelineConfig() ?? (await ensureFacebookPipeline());
  const stageId = config.stages["New Lead"];
  const ownerId = getPipedriveOwner()?.id;

  const orgId = await resolveOrg(lead.companyId, ownerId);
  const personId = await resolvePerson(lead.companyId, orgId, ownerId);

  const company = sqlite.prepare("SELECT name FROM companies WHERE id = ?").get(lead.companyId) as { name: string | null } | undefined;
  const title = `${lead.contactName || company?.name || "Facebook lead"} — Facebook lead`;

  const body: Record<string, unknown> = {
    title,
    org_id: orgId,
    pipeline_id: config.pipelineId,
    stage_id: stageId,
    status: "open",
  };
  if (personId) body.person_id = personId;
  if (ownerId) body.user_id = ownerId;

  const created = await createDeal(body as { title: string });

  // Attribution note (best-effort — a note failure shouldn't fail the push).
  try {
    await createNote({ content: buildNote(lead), deal_id: created.id, org_id: orgId });
  } catch (e) {
    console.warn("[meta/pipedrive] note create failed (non-fatal):", e instanceof Error ? e.message : e);
  }

  // Mirror into pipedrive_deals so the frame's Pipedrive panels render it.
  sqlite
    .prepare(
      `INSERT INTO pipedrive_deals (id, pipedrive_deal_id, company_id, pipeline, stage, status, is_open, title, created_at, updated_at)
       VALUES (lower(hex(randomblob(16))), ?, ?, 'facebook', 'New Lead', 'open', 1, ?, datetime('now'), datetime('now'))
       ON CONFLICT(pipedrive_deal_id) DO NOTHING`,
    )
    .run(created.id, lead.companyId, title);

  sqlite
    .prepare("UPDATE meta_leads SET pipedrive_deal_id = ?, pipedrive_person_id = ? WHERE id = ?")
    .run(created.id, personId ?? null, lead.metaLeadId);

  return { dealId: created.id, personId, orgId, action: "created", dealUrl: dealUrl(created.id) };
}

export function dealUrl(dealId: number | null): string | null {
  if (!dealId) return null;
  const apiDomain = (getPipedriveConnectionStatus().apiDomain || "").replace(/\/$/, "");
  return apiDomain ? `${apiDomain}/deal/${dealId}` : null;
}
