/**
 * Shared persistence for AI-produced email copy — used by both the
 * initial generate-copy route and the natural-language revise-copy
 * route, so they write identically (snapshot-before-overwrite, the same
 * COALESCE-on-empty rules, the same QA lint).
 */
import { db, sqlite } from "@/lib/db";
import { emailCampaigns } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { snapshotCopy } from "./copy-versions";
import { lintGeneratedCopy } from "./copy-quality";
import { briefFingerprint } from "./brief-fingerprint";

/**
 * Snapshot the current copy (for undo), write the new copy onto the
 * campaign row, run deterministic QA, and return the updated row +
 * advisory self-checks + lint.
 *
 * @param snapshotSource label for the version snapshot (e.g.
 *   "pre_generate" | "pre_revise") so Copy history shows why it was taken.
 */
export async function persistGeneratedCopy(
  id: string,
  campaign: Record<string, unknown>,
  out: Record<string, unknown>,
  snapshotSource: string,
) {
  // Snapshot BEFORE overwrite so a worse generation/revision is
  // non-destructive (restore from Copy history). No-op if no copy yet.
  try {
    snapshotCopy(campaign, snapshotSource);
  } catch (e) {
    console.warn("[copy-persist] snapshot failed (non-fatal):", e);
  }

  const s = (k: string) => (out[k] == null ? null : String(out[k]));

  sqlite.prepare(
    `UPDATE marketing_email_campaigns SET
       name = CASE WHEN COALESCE(NULLIF(name, ''), NULL) IS NULL THEN ? ELSE name END,
       brief_title = CASE WHEN COALESCE(NULLIF(brief_title, ''), NULL) IS NULL THEN ? ELSE brief_title END,
       subject = ?, preheader = ?,
       subject_alt = ?, preheader_alt = ?,
       hero_headline = ?, hero_subtitle = ?,
       hero_cta_label = ?, hero_cta_url = COALESCE(NULLIF(hero_cta_url, ''), ?),
       section_a_heading = ?, section_a_body = ?,
       section_b_heading = ?, section_b_body = ?,
       section_b_cta_label = ?, section_b_cta_url = COALESCE(NULLIF(section_b_cta_url, ''), ?),
       ai_copy_prompt_version = 'v5',
       ai_copy_raw_json = ?,
       status = CASE WHEN status IN ('draft','copywriting') THEN 'copywriting' ELSE status END,
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    s("proposedName"),
    s("proposedName"),
    s("subject"),
    s("preheader"),
    s("subjectAlt"),
    s("preheaderAlt"),
    s("heroHeadline"),
    s("heroSubtitle"),
    s("heroCtaLabel"),
    s("heroCtaUrlSuggestion"),
    s("sectionAHeading"),
    s("sectionABody"),
    s("sectionBHeading"),
    s("sectionBBody"),
    s("sectionBCtaLabel"),
    s("sectionBCtaUrlSuggestion"),
    JSON.stringify(out),
    id,
  );

  const selfChecks = (out.selfCheckPassed ?? {}) as Record<string, boolean>;
  const failedChecks = Object.entries(selfChecks)
    .filter(([, v]) => v === false)
    .map(([k]) => k);

  const lint = lintGeneratedCopy(out, campaign.audience as "retail" | "wholesale");

  const [updated] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);

  // Record what the brief looked like when THIS copy was written (post-
  // update row, since generate-copy may have just filled empty brief
  // columns). The editor compares live brief fields against this to nudge
  // "brief changed — regenerate?" instead of shipping stale copy.
  if (updated) {
    sqlite
      .prepare(`UPDATE marketing_email_campaigns SET copy_brief_fingerprint = ? WHERE id = ?`)
      .run(
        briefFingerprint({
          name: updated.name,
          briefAngle: updated.briefAngle,
          briefProductHook: updated.briefProductHook,
          briefSeasonalContext: updated.briefSeasonalContext,
        }),
        id,
      );
  }

  return { updated, failedChecks, lint };
}
