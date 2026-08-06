/**
 * Outreach suppression — the one place that answers "may we message this
 * company?" Every outreach path (sequence engine, campaigns, the Faire queue)
 * must go through this rather than inventing its own rule.
 *
 * Suppressed when ANY of:
 *  - companies.do_not_contact = 1 (explicit: they declined, or we flagged them)
 *  - the company reached a terminal "stop" status (not_interested / ghosted)
 *  - any campaign_lead for the company is 'unsubscribed'
 *
 * Fail closed: an unknown company id counts as suppressed. Silence is cheap;
 * messaging someone who told us to stop is not.
 *
 * See docs/outreach-sequence-engine.md §9.
 */

import { sqlite } from "@/lib/db";

export type SuppressionReason =
  | "do_not_contact"
  | "status_not_interested"
  | "status_ghosted"
  | "unsubscribed"
  | "unknown_company";

export interface SuppressionResult {
  suppressed: boolean;
  reason?: SuppressionReason;
  detail?: string | null;
}

export function checkSuppression(companyId: string): SuppressionResult {
  const row = sqlite
    .prepare(
      `SELECT c.id, c.status, c.do_not_contact, c.do_not_contact_reason,
              (SELECT COUNT(*) FROM campaign_leads cl
                WHERE cl.company_id = c.id AND cl.status = 'unsubscribed') AS unsub
         FROM companies c WHERE c.id = ?`,
    )
    .get(companyId) as
    | { id: string; status: string | null; do_not_contact: number | null; do_not_contact_reason: string | null; unsub: number }
    | undefined;

  if (!row) return { suppressed: true, reason: "unknown_company" };
  if (row.do_not_contact) {
    return { suppressed: true, reason: "do_not_contact", detail: row.do_not_contact_reason };
  }
  if (row.status === "not_interested") return { suppressed: true, reason: "status_not_interested" };
  if (row.status === "ghosted") return { suppressed: true, reason: "status_ghosted" };
  if (row.unsub > 0) return { suppressed: true, reason: "unsubscribed" };
  return { suppressed: false };
}

/** Convenience boolean form. */
export function isSuppressed(companyId: string): boolean {
  return checkSuppression(companyId).suppressed;
}

/** Flag a company as do-not-contact. Idempotent. */
export function setDoNotContact(companyId: string, reason: string): void {
  sqlite
    .prepare(
      `UPDATE companies
          SET do_not_contact = 1, do_not_contact_reason = ?, do_not_contact_at = ?
        WHERE id = ?`,
    )
    .run(reason, new Date().toISOString(), companyId);
}

/** Clear the flag (they came back / it was a mistake). */
export function clearDoNotContact(companyId: string): void {
  sqlite
    .prepare(
      `UPDATE companies
          SET do_not_contact = 0, do_not_contact_reason = NULL, do_not_contact_at = NULL
        WHERE id = ?`,
    )
    .run(companyId);
}

/**
 * Bulk-resolve which of a set of companies may be messaged. Cheaper than N
 * single lookups for the engine's enrollment scan.
 */
export function filterMessageable(companyIds: string[]): string[] {
  if (!companyIds.length) return [];
  const placeholders = companyIds.map(() => "?").join(",");
  const rows = sqlite
    .prepare(
      `SELECT c.id FROM companies c
        WHERE c.id IN (${placeholders})
          AND COALESCE(c.do_not_contact, 0) = 0
          AND COALESCE(c.status, '') NOT IN ('not_interested', 'ghosted')
          AND NOT EXISTS (SELECT 1 FROM campaign_leads cl
                           WHERE cl.company_id = c.id AND cl.status = 'unsubscribed')`,
    )
    .all(...companyIds) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}
