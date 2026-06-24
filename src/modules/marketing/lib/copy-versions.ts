/**
 * Copy version history.
 *
 * generate-copy is destructive — it overwrites the campaign's copy with
 * the new AI output. If the new copy is worse than what you had, the
 * prior version is gone. This module snapshots the copy fields BEFORE
 * each regenerate so the operator can restore a previous version.
 *
 * Storage: one row per snapshot in marketing_email_copy_versions, with
 * the copy fields as a JSON blob (camelCase keys) + a display label.
 */

import { sqlite } from "@/lib/db";

/** camelCase field → snake_case column for the copy fields we version. */
export const COPY_FIELD_COLUMNS: Record<string, string> = {
  name: "name",
  subject: "subject",
  preheader: "preheader",
  subjectAlt: "subject_alt",
  preheaderAlt: "preheader_alt",
  heroHeadline: "hero_headline",
  heroSubtitle: "hero_subtitle",
  heroCtaLabel: "hero_cta_label",
  heroCtaUrl: "hero_cta_url",
  sectionAHeading: "section_a_heading",
  sectionABody: "section_a_body",
  sectionBHeading: "section_b_heading",
  sectionBBody: "section_b_body",
  sectionBCtaLabel: "section_b_cta_label",
  sectionBCtaUrl: "section_b_cta_url",
};

const MAX_VERSIONS = 15;

function snapshotFrom(campaign: Record<string, unknown>): Record<string, string> {
  const snap: Record<string, string> = {};
  for (const key of Object.keys(COPY_FIELD_COLUMNS)) {
    const v = campaign[key];
    if (typeof v === "string" && v.trim().length > 0) snap[key] = v;
  }
  return snap;
}

/**
 * Snapshot the campaign's CURRENT copy as a version. No-op if the copy
 * is entirely empty (nothing worth preserving — e.g. a fresh draft's
 * first generation). Prunes to the most recent MAX_VERSIONS.
 */
export function snapshotCopy(campaign: Record<string, unknown>, source: string): void {
  const snap = snapshotFrom(campaign);
  if (Object.keys(snap).length === 0) return;

  const label =
    (campaign.subject as string) ||
    (campaign.heroHeadline as string) ||
    (campaign.name as string) ||
    "(untitled)";

  sqlite
    .prepare(
      `INSERT INTO marketing_email_copy_versions
         (id, campaign_id, snapshot_json, source, label, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(crypto.randomUUID(), campaign.id as string, JSON.stringify(snap), source, label.slice(0, 120));

  // Prune: keep the newest MAX_VERSIONS for this campaign.
  sqlite
    .prepare(
      `DELETE FROM marketing_email_copy_versions
        WHERE campaign_id = ?
          AND id NOT IN (
            SELECT id FROM marketing_email_copy_versions
             WHERE campaign_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ?
          )`,
    )
    .run(campaign.id as string, campaign.id as string, MAX_VERSIONS);
}

export interface VersionRow {
  id: string;
  source: string | null;
  label: string | null;
  createdAt: string | null;
  fields: Record<string, string>;
}

export function listVersions(campaignId: string): VersionRow[] {
  const rows = sqlite
    .prepare(
      `SELECT id, snapshot_json, source, label, created_at
         FROM marketing_email_copy_versions
        WHERE campaign_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(campaignId, MAX_VERSIONS) as Array<{
      id: string; snapshot_json: string; source: string | null; label: string | null; created_at: string | null;
    }>;
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    label: r.label,
    createdAt: r.created_at,
    fields: safeParse(r.snapshot_json),
  }));
}

/**
 * Restore a version's copy fields onto the campaign. Before restoring,
 * snapshots the CURRENT copy (source 'pre_restore') so restore is also
 * undoable. Returns false if the version doesn't exist / belongs to a
 * different campaign.
 */
export function restoreVersion(campaignId: string, versionId: string): boolean {
  const row = sqlite
    .prepare(`SELECT campaign_id, snapshot_json FROM marketing_email_copy_versions WHERE id = ?`)
    .get(versionId) as { campaign_id: string; snapshot_json: string } | undefined;
  if (!row || row.campaign_id !== campaignId) return false;

  const current = sqlite
    .prepare(`SELECT * FROM marketing_email_campaigns WHERE id = ?`)
    .get(campaignId) as Record<string, unknown> | undefined;
  if (current) {
    // Re-key the snake row into the camel keys snapshotCopy expects.
    const camel: Record<string, unknown> = { id: campaignId };
    for (const [k, col] of Object.entries(COPY_FIELD_COLUMNS)) camel[k] = current[col];
    camel.subject = current.subject; camel.heroHeadline = current.hero_headline; camel.name = current.name;
    snapshotCopy(camel, "pre_restore");
  }

  const snap = safeParse(row.snapshot_json);
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [key, col] of Object.entries(COPY_FIELD_COLUMNS)) {
    if (key in snap) { sets.push(`${col} = ?`); vals.push(snap[key]); }
  }
  if (sets.length === 0) return false;
  vals.push(campaignId);
  sqlite
    .prepare(`UPDATE marketing_email_campaigns SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`)
    .run(...vals);
  return true;
}

function safeParse(s: string): Record<string, string> {
  try {
    const o = JSON.parse(s);
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}
