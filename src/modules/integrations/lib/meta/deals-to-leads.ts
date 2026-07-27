/**
 * One-off: move Facebook ad submissions that were pushed as Pipedrive **deals**
 * into the Leads Inbox, where they belong.
 *
 * Before this change every ad submission opened a deal in the "Facebook Leads"
 * pipeline. That inflates pipeline value and conversion reporting with people
 * nobody has spoken to. Going forward they're created as leads; this backfills
 * the ones already in the pipeline.
 *
 * Order matters: create the lead first, stamp it, and only then delete the
 * deal. If the run dies halfway, the worst case is a lead and a deal existing
 * together (visible, fixable) rather than a submission disappearing from
 * Pipedrive entirely.
 *
 * Defaults to a dry run — deleting deals from a live CRM shouldn't be one
 * accidental request away.
 */

import { sqlite } from "@/lib/db";
import {
  pdRequest,
  createLead,
  createNote,
  ensureLeadLabel,
  getPipedriveConnectionStatus,
  PipedriveError,
} from "@/modules/sales/lib/pipedrive-client";

interface Row {
  id: string;
  leadgen_id: string;
  pipedrive_deal_id: number;
  pipedrive_person_id: number | null;
  company_id: string | null;
  full_name: string | null;
  campaign_name: string | null;
  adset_name: string | null;
  ad_name: string | null;
  form_id: string | null;
  field_data: string | null;
  company_name: string | null;
  pipedrive_org_id: number | null;
}

export interface DealsToLeadsResult {
  dryRun: boolean;
  candidates: number;
  converted: number;
  dealsDeleted: number;
  skipped: Array<{ leadgenId: string; reason: string }>;
  errors: Array<{ leadgenId: string; reason: string }>;
  /** Sample of what would happen, so a dry run is actually reviewable. */
  preview: Array<{ leadgenId: string; title: string; dealId: number }>;
}

function buildNote(r: Row): string {
  const lines: string[] = ["<b>New Facebook/Instagram Lead Ad submission</b>"];
  const attribution = [
    r.campaign_name ? `Campaign: ${r.campaign_name}` : "",
    r.adset_name ? `Ad set: ${r.adset_name}` : "",
    r.ad_name ? `Ad: ${r.ad_name}` : "",
    r.form_id ? `Form: ${r.form_id}` : "",
  ].filter(Boolean);
  if (attribution.length) lines.push(attribution.join(" · "));
  try {
    const fields = r.field_data ? (JSON.parse(r.field_data) as Array<{ name: string; values: string[] }>) : [];
    if (fields.length) {
      lines.push("");
      for (const f of fields) lines.push(`<b>${f.name.replace(/_/g, " ")}:</b> ${(f.values || []).join(", ")}`);
    }
  } catch { /* field_data is best-effort context, not worth failing over */ }
  return lines.join("<br>");
}

export async function migrateFacebookDealsToLeads(
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<DealsToLeadsResult> {
  const dryRun = opts.dryRun !== false;
  const result: DealsToLeadsResult = {
    dryRun, candidates: 0, converted: 0, dealsDeleted: 0, skipped: [], errors: [], preview: [],
  };

  if (!getPipedriveConnectionStatus().connected) {
    result.errors.push({ leadgenId: "-", reason: "Pipedrive is not connected" });
    return result;
  }

  const rows = sqlite
    .prepare(
      `SELECT ml.id, ml.leadgen_id, ml.pipedrive_deal_id, ml.pipedrive_person_id, ml.company_id,
              ml.full_name, ml.campaign_name, ml.adset_name, ml.ad_name, ml.form_id, ml.field_data,
              c.name AS company_name, c.pipedrive_org_id
         FROM meta_leads ml
         LEFT JOIN companies c ON c.id = ml.company_id
        WHERE ml.pipedrive_deal_id IS NOT NULL AND ml.pipedrive_lead_id IS NULL
        ORDER BY ml.created_at ASC
        LIMIT ?`,
    )
    .all(Math.max(1, Math.floor(opts.limit ?? 500))) as Row[];

  result.candidates = rows.length;
  if (rows.length === 0) return result;

  const labelId = await ensureLeadLabel("Facebook Ads", "blue").then((l) => l.id).catch(() => null);

  for (const r of rows) {
    const title = `${r.full_name || r.company_name || "Facebook lead"} — Facebook lead`;

    if (!r.pipedrive_org_id && !r.pipedrive_person_id) {
      result.skipped.push({ leadgenId: r.leadgen_id, reason: "no Pipedrive org or person to attach the lead to" });
      continue;
    }

    if (dryRun) {
      result.preview.push({ leadgenId: r.leadgen_id, title, dealId: r.pipedrive_deal_id });
      continue;
    }

    try {
      const body: Record<string, unknown> = { title };
      if (r.pipedrive_org_id) body.organization_id = r.pipedrive_org_id;
      if (r.pipedrive_person_id) body.person_id = r.pipedrive_person_id;
      if (labelId) body.label_ids = [labelId];

      const lead = await createLead(body as { title: string });

      // Stamp before deleting the deal, so a crash here leaves both visible
      // rather than losing the submission from Pipedrive.
      sqlite
        .prepare("UPDATE meta_leads SET pipedrive_lead_id = ?, pipedrive_deal_id = NULL WHERE id = ?")
        .run(lead.id, r.id);
      result.converted++;

      try {
        await createNote({ content: buildNote(r), lead_id: lead.id, org_id: r.pipedrive_org_id ?? undefined });
      } catch { /* note is context, not the record */ }

      try {
        await pdRequest("DELETE", `/deals/${r.pipedrive_deal_id}`);
        sqlite.prepare("DELETE FROM pipedrive_deals WHERE pipedrive_deal_id = ?").run(r.pipedrive_deal_id);
        result.dealsDeleted++;
      } catch (e) {
        // 404/410 both mean the deal is gone — Pipedrive answers a successful
        // delete with 410 and a `{"success":true}` body, which fetch treats as
        // a failure. Neither is worth surfacing; anything else is.
        if (!(e instanceof PipedriveError && (e.status === 404 || e.status === 410))) {
          result.errors.push({
            leadgenId: r.leadgen_id,
            reason: `lead created but deal ${r.pipedrive_deal_id} could not be deleted: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
    } catch (e) {
      result.errors.push({ leadgenId: r.leadgen_id, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return result;
}
