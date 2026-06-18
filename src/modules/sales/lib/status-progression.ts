/**
 * companies.status pipeline + one-way progression.
 *
 * The lead-gen lifecycle (per Daniel 2026-06-19):
 *
 *   prospect          → all imported leads (default)
 *   not_qualified     → ICP fail (pre-outreach disqualification)
 *   qualified_lead    → pushed to Instantly/PhoneBurner; awaiting response
 *   interested        → replied positively (lead_interested event)
 *   catalog_sent      → Christina sent the catalog
 *   revisit_later     → "ping me in a few months" type response
 *   not_interested    → replied negatively (lead_not_interested event)
 *   ghosted           → outreach finished with no reply
 *   customer          → placed an order (the win — terminal)
 *
 * `progressCompanyStatus` enforces three rules:
 *   1. Forward-progress only — never downgrade rank.
 *   2. Customer is terminal — webhook events can't take a customer back.
 *   3. Sibling terminals (not_qualified / not_interested / ghosted /
 *      revisit_later) don't override each other. A lead can move from
 *      those to a forward state via explicit manual re-qualification,
 *      handled separately.
 */
import { sqlite } from "@/lib/db";

export const COMPANY_STATUSES = [
  "prospect",
  "not_qualified",
  "qualified_lead",
  "interested",
  "catalog_sent",
  "revisit_later",
  "not_interested",
  "ghosted",
  "customer",
] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

/**
 * Rank is the pipeline order. Higher rank = further along.
 * Terminal "no" states (not_qualified, not_interested, ghosted,
 * revisit_later) share rank 4 — none overrides another.
 * Customer is rank 5 — terminal "yes", never downgraded.
 */
const RANK: Record<CompanyStatus, number> = {
  prospect: 0,
  not_qualified: 0,
  qualified_lead: 1,
  interested: 2,
  catalog_sent: 3,
  revisit_later: 4,
  not_interested: 4,
  ghosted: 4,
  customer: 5,
};

/** Whether `to` should overwrite `from` under one-way rules. */
function shouldProgress(from: string | null, to: CompanyStatus): boolean {
  // Unknown / legacy statuses → trust the new target.
  if (!from || !(from in RANK)) return true;
  // Never downgrade a customer.
  if (from === "customer") return false;
  // Same rank → only progress if from is the entry-rank "prospect" state.
  // (Don't bump not_qualified to a sibling terminal silently.)
  const fromRank = RANK[from as CompanyStatus];
  const toRank = RANK[to];
  if (toRank > fromRank) return true;
  if (toRank === fromRank && from === "prospect" && to !== "prospect") return true;
  return false;
}

/**
 * Progress a company's status if the proposed value is further along the
 * pipeline. No-op if the company is already at or past `to`. Returns
 * whether an UPDATE actually happened.
 */
export function progressCompanyStatus(
  companyId: string,
  to: CompanyStatus,
): { updated: boolean; from: string | null; to: CompanyStatus } {
  const row = sqlite
    .prepare("SELECT status FROM companies WHERE id = ?")
    .get(companyId) as { status: string | null } | undefined;
  const from = row?.status ?? null;
  if (!shouldProgress(from, to)) {
    return { updated: false, from, to };
  }
  sqlite
    .prepare("UPDATE companies SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(to, companyId);
  return { updated: true, from, to };
}
