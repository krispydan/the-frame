/**
 * Omnisend API client — pushes a finished the-frame email campaign into
 * Omnisend as a draft (or scheduled) campaign, replacing the manual
 * "download HTML → paste into Omnisend" step.
 *
 * Chain (per api-docs.omnisend.com):
 *   1. POST /api/email-templates/import   { name, html }  → templateID
 *   2. POST /api/campaigns                { ..., content.email.templateID }
 *   3. POST /api/campaigns/{id}/send      (only when sending/scheduling)
 *
 * Flag-gated: everything no-ops with a clear "not configured" error until
 * OMNISEND_API_KEY is set (env var or settings table key omnisend_api_key),
 * so shipping this changes nothing until Daniel drops the key in.
 */
import { sqlite } from "@/lib/db";

// Auth/endpoint shape per the CURRENT Omnisend API docs (api-docs.omnisend.com,
// "Campaigns" + "Email templates import" references, fetched 2026-07-07):
//   Authorization: Omnisend-API-Key <key>   (NOT the legacy v3 X-API-KEY)
//   base https://api.omnisend.com/api        (NOT the legacy /v3)
//   Omnisend-Version: 2026-03-15
// If a live call 401s, re-check those pages first — Omnisend renamed both the
// header and the base between v3/v5 and the 2026 versions.
const API_BASE = "https://api.omnisend.com/api";
const API_VERSION = "2026-03-15";

export function getOmnisendApiKey(): string | null {
  if (process.env.OMNISEND_API_KEY) return process.env.OMNISEND_API_KEY;
  try {
    const row = sqlite
      .prepare("SELECT value FROM settings WHERE key = 'omnisend_api_key' LIMIT 1")
      .get() as { value: string | null } | undefined;
    return row?.value || null;
  } catch {
    return null;
  }
}

export function isOmnisendConfigured(): boolean {
  return !!getOmnisendApiKey();
}

type OmniResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function omniFetch<T>(path: string, init?: RequestInit): Promise<OmniResult<T>> {
  const key = getOmnisendApiKey();
  if (!key) {
    return { ok: false, error: "Omnisend not configured — set OMNISEND_API_KEY (env) or the omnisend_api_key setting." };
  }
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Omnisend-API-Key ${key}`,
        "Omnisend-Version": API_VERSION,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `Omnisend ${path} → HTTP ${res.status}: ${text.slice(0, 300)}` };
    }
    return { ok: true, data: (text ? JSON.parse(text) : {}) as T };
  } catch (e) {
    return { ok: false, error: `Omnisend ${path} failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Import raw HTML as an Omnisend email template (max 1 MB). */
export async function importTemplate(name: string, html: string): Promise<OmniResult<{ templateID: string }>> {
  if (Buffer.byteLength(html, "utf8") > 1_000_000) {
    return { ok: false, error: "Email HTML exceeds Omnisend's 1 MB template-import limit." };
  }
  const res = await omniFetch<{ templateID?: string; id?: string }>("/email-templates/import", {
    method: "POST",
    body: JSON.stringify({ name: name.slice(0, 255), html }),
  });
  if (!res.ok) return res;
  const templateID = res.data.templateID ?? res.data.id;
  if (!templateID) return { ok: false, error: "Omnisend template import returned no templateID." };
  return { ok: true, data: { templateID } };
}

export interface OmnisendCampaignInput {
  name: string;
  subject: string;
  preheader?: string | null;
  senderName: string;
  senderEmail?: string | null;
  templateID: string;
  /** ISO timestamp → scheduled; omitted → created as a draft to review in Omnisend. */
  scheduledAt?: string | null;
  includedSegmentIDs?: string[];
}

/** Create the campaign (draft unless scheduledAt given). Returns campaign id. */
export async function createCampaign(input: OmnisendCampaignInput): Promise<OmniResult<{ campaignID: string }>> {
  const body: Record<string, unknown> = {
    name: input.name.slice(0, 250),
    type: "regular",
    channel: "email",
    content: {
      email: {
        subject: input.subject.slice(0, 250),
        senderName: input.senderName.slice(0, 250),
        ...(input.senderEmail ? { senderEmail: input.senderEmail } : {}),
        ...(input.preheader ? { preheader: input.preheader.slice(0, 250) } : {}),
        templateID: input.templateID,
      },
    },
    ...(input.includedSegmentIDs?.length
      ? { audience: { includedSegmentIDs: input.includedSegmentIDs } }
      : {}),
    ...(input.scheduledAt
      ? { sendingSettings: { strategy: "scheduled", scheduledAt: input.scheduledAt } }
      : {}),
  };
  const res = await omniFetch<{ campaignID?: string; id?: string }>("/campaigns", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) return res;
  const campaignID = res.data.campaignID ?? res.data.id;
  if (!campaignID) return { ok: false, error: "Omnisend campaign create returned no id." };
  return { ok: true, data: { campaignID } };
}

/** Kick off delivery/scheduling for a created campaign. */
export async function sendCampaign(campaignID: string): Promise<OmniResult<Record<string, unknown>>> {
  return omniFetch(`/campaigns/${encodeURIComponent(campaignID)}/send`, { method: "POST" });
}
