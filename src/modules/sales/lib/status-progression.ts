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
 *
 * Side-effects (only when `updated === true`):
 *
 *   1. The matching `deals` row's stage is upserted to mirror the new
 *      status, so the kanban board stays in sync. Pre-interested
 *      states don't create a deal.
 *
 *   2. The change fans out to the OTHER external platforms (Instantly
 *      + PhoneBurner) where this lead lives, so a status change in
 *      one place propagates everywhere. The `opts.source` parameter
 *      identifies the origin of the change so we skip syncing back to
 *      it (loop prevention). See ./status-sync.ts.
 *
 * Idempotent re-progressions (status unchanged) skip BOTH side-effects.
 * That's how we kill echo loops: when Instantly fires lead_interested,
 * we update locally → fan out to PB only (not Instantly). When PB then
 * fires its own update echoing the Instantly value, our progression is
 * a no-op → no fan-out at all.
 */
export function progressCompanyStatus(
  companyId: string,
  to: CompanyStatus,
  opts?: { source?: "instantly" | "phoneburner" | "pipedrive" | "ui" | "system" },
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
  syncDealStage(companyId, to);

  // Fan out to external platforms. Default source "system" — anything
  // that doesn't specify is treated as Frame-initiated (not from a
  // specific external webhook), so both platforms get notified.
  //
  // Lazy import to avoid a circular-dependency loop: status-sync.ts
  // registers job handlers at module load, and the handlers themselves
  // import the Instantly/PB clients. Importing it at the top would
  // mean status-progression → status-sync → instantly-client → ...
  // get loaded synchronously together at every entry point.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fanOutStatusChange } = require("./status-sync") as typeof import("./status-sync");
    fanOutStatusChange(companyId, to, opts?.source ?? "system");
  } catch (e) {
    // Fan-out failure must NOT prevent the local state change. Log
    // and move on — the job worker will retry the syncs if any
    // enqueued.
    console.error("[status-progression] fan-out failed:", e);
  }

  return { updated: true, from, to };
}

/**
 * Map a companies.status value to the matching deals.stage. Returns null
 * for pre-interested states — those don't surface on the kanban.
 */
function dealStageFor(status: CompanyStatus): string | null {
  switch (status) {
    case "interested":     return "interested";
    case "catalog_sent":   return "catalog_sent";
    case "revisit_later":  return "interested_later";
    case "not_interested": return "not_interested";
    case "ghosted":        return "ghosted";
    case "customer":       return "order_placed";
    // prospect / not_qualified / qualified_lead → not on the board
    default: return null;
  }
}

/**
 * Upsert a deal row whose stage mirrors the company's status. Creates
 * a new deal if none exists for this company, otherwise updates the
 * existing row's stage in place.
 *
 * Best-effort — a failure here doesn't roll back the companies.status
 * update (that's the source of truth). Logged for visibility.
 */
function syncDealStage(companyId: string, status: CompanyStatus): void {
  const stage = dealStageFor(status);
  if (!stage) return;

  try {
    const existing = sqlite
      .prepare("SELECT id FROM deals WHERE company_id = ? ORDER BY created_at ASC LIMIT 1")
      .get(companyId) as { id: string } | undefined;

    if (existing) {
      sqlite
        .prepare("UPDATE deals SET stage = ?, updated_at = datetime('now') WHERE id = ?")
        .run(stage, existing.id);
      return;
    }

    // No deal yet — auto-create one. Pull a sensible default title +
    // value/owner from the company so the kanban card has context.
    const company = sqlite
      .prepare("SELECT name, owner_id FROM companies WHERE id = ?")
      .get(companyId) as { name: string | null; owner_id: string | null } | undefined;
    const title = company?.name ? `${company.name} — wholesale` : "Wholesale opportunity";
    sqlite
      .prepare(
        `INSERT INTO deals
           (id, company_id, title, stage, channel, owner_id, value,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, 'other', ?, 0, datetime('now'), datetime('now'))`,
      )
      .run(
        crypto.randomUUID(),
        companyId,
        title,
        stage,
        company?.owner_id ?? null,
      );
  } catch (e) {
    console.error("[status-progression] syncDealStage failed:", e);
  }
}
