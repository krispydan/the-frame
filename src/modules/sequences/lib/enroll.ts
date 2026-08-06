/**
 * Manual and bulk enrollment (T2 campaigns, and "put this shop in that
 * sequence" from an account page).
 *
 * Every path funnels through enrollOne so the guards can't be bypassed by
 * whichever screen is calling: suppression, one-live-enrollment, the 90-day
 * re-enroll bar, and cooldowns all apply the same way they do for automatic
 * enrollment. A human choosing the sequence changes WHO gets picked, not
 * whether it is safe to message them.
 */

import { sqlite } from "@/lib/db";
import { randomUUID } from "crypto";
import { checkSuppression, lastOutreach } from "@/modules/sales/lib/suppression";
import { getSetting } from "./engine";

export type EnrollSkipReason =
  | "suppressed" | "already_enrolled" | "recently_in_sequence"
  | "cooldown_same_brand" | "cooldown_cross_brand" | "no_such_sequence" | "no_steps";

export interface EnrollOutcome {
  ok: boolean;
  enrollmentId?: string;
  skipped?: EnrollSkipReason;
  detail?: string;
}

const addDays = (days: number) => new Date(Date.now() + days * 86400000).toISOString();

/**
 * The whole guard chain, in one place, so a preview and a real run can never
 * disagree about what would happen. Returns null when enrollment is allowed.
 */
export function checkEnrollable(
  sequenceId: string,
  companyId: string,
  opts: { force?: boolean } = {},
): { reason: EnrollSkipReason; detail?: string } | null {
  const seq = sqlite
    .prepare("SELECT id, brand, class FROM sequences WHERE id = ?")
    .get(sequenceId) as { id: string; brand: string; class: string } | undefined;
  if (!seq) return { reason: "no_such_sequence" };
  const firstStep = sqlite
    .prepare("SELECT id FROM sequence_steps WHERE sequence_id = ? ORDER BY step_no ASC LIMIT 1")
    .get(sequenceId);
  if (!firstStep) return { reason: "no_steps" };

  const sup = checkSuppression(companyId, seq.brand);
  if (sup.suppressed) return { reason: "suppressed", detail: sup.reason };

  const busy = sqlite
    .prepare("SELECT id FROM sequence_enrollments WHERE company_id = ? AND status IN ('active','paused_t0') LIMIT 1")
    .get(companyId);
  if (busy) return { reason: "already_enrolled" };

  if (!opts.force) {
    const recent = sqlite
      .prepare("SELECT 1 FROM sequence_enrollments WHERE company_id = ? AND sequence_id = ? AND status != 'proposed' AND enrolled_at > ? LIMIT 1")
      .get(companyId, sequenceId, addDays(-90));
    if (recent) return { reason: "recently_in_sequence" };

    if (seq.class === "nudge") {
      const last = lastOutreach(companyId);
      const cooldown = Number(getSetting("seq.cooldown_days", "14"));
      const cross = Number(getSetting("seq.cross_brand_cooldown_days", "7"));
      const sameBrand = last.byBrand[seq.brand];
      if (sameBrand && Date.parse(sameBrand) > Date.parse(addDays(-cooldown))) {
        return { reason: "cooldown_same_brand", detail: sameBrand };
      }
      if (last.lastAnyAt && Date.parse(last.lastAnyAt) > Date.parse(addDays(-cross))) {
        return { reason: "cooldown_cross_brand", detail: `${last.lastAnyBrand} ${last.lastAnyAt}` };
      }
    }
  }
  return null;
}

export function enrollOne(
  sequenceId: string,
  companyId: string,
  opts: { by?: string; force?: boolean } = {},
): EnrollOutcome {
  const blocked = checkEnrollable(sequenceId, companyId, opts);
  if (blocked) return { ok: false, skipped: blocked.reason, detail: blocked.detail };

  const firstStep = sqlite
    .prepare("SELECT delay_days FROM sequence_steps WHERE sequence_id = ? ORDER BY step_no ASC LIMIT 1")
    .get(sequenceId) as { delay_days: number };

  const id = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO sequence_enrollments (id, sequence_id, company_id, status, current_step, next_step_due_at, enrolled_by, enrolled_at)
       VALUES (?, ?, ?, 'active', 0, ?, ?, ?)`,
    )
    .run(id, sequenceId, companyId, addDays(firstStep.delay_days || 0), opts.by || "manual", new Date().toISOString());
  return { ok: true, enrollmentId: id };
}

export interface BulkResult {
  requested: number;
  enrolled: number;
  skipped: Record<string, number>;
  samples: Array<{ company: string; reason: string }>;
}

/** Bulk enroll. Reports every reason a shop was left out, rather than a bare count. */
export function enrollMany(
  sequenceId: string,
  companyIds: string[],
  opts: { by?: string; force?: boolean; dryRun?: boolean } = {},
): BulkResult {
  const res: BulkResult = { requested: companyIds.length, enrolled: 0, skipped: {}, samples: [] };
  for (const companyId of companyIds) {
    if (opts.dryRun) {
      // Exactly the same guard chain as the real path — a preview that under-
      // counts exclusions is worse than no preview, because it gets trusted.
      const blocked = checkEnrollable(sequenceId, companyId, opts);
      if (blocked) {
        res.skipped[blocked.reason] = (res.skipped[blocked.reason] || 0) + 1;
        if (res.samples.length < 15) {
          const name = (sqlite.prepare("SELECT name FROM companies WHERE id = ?").get(companyId) as { name: string } | undefined)?.name;
          res.samples.push({ company: name || companyId, reason: blocked.reason });
        }
      } else res.enrolled++;
      continue;
    }
    const out = enrollOne(sequenceId, companyId, opts);
    if (out.ok) res.enrolled++;
    else {
      const r = out.skipped || "unknown";
      res.skipped[r] = (res.skipped[r] || 0) + 1;
      if (res.samples.length < 15) {
        const name = (sqlite.prepare("SELECT name FROM companies WHERE id = ?").get(companyId) as { name: string } | undefined)?.name;
        res.samples.push({ company: name || companyId, reason: r });
      }
    }
  }
  return res;
}

/** Resolve a saved smart list to company ids, so campaigns can target one. */
export function companiesFromSmartList(smartListId: string, limit = 500): string[] {
  const row = sqlite.prepare("SELECT filters FROM smart_lists WHERE id = ?").get(smartListId) as { filters: string } | undefined;
  if (!row) return [];
  let f: Record<string, unknown> = {};
  try { f = JSON.parse(row.filters || "{}"); } catch { return []; }
  const where: string[] = ["1=1"];
  const params: unknown[] = [];
  if (typeof f.status === "string") { where.push("status = ?"); params.push(f.status); }
  if (typeof f.state === "string") { where.push("state = ?"); params.push(f.state); }
  if (typeof f.icp_tier === "string") { where.push("icp_tier = ?"); params.push(f.icp_tier); }
  params.push(limit);
  return (sqlite
    .prepare(`SELECT id FROM companies WHERE ${where.join(" AND ")} LIMIT ?`)
    .all(...params) as Array<{ id: string }>).map((r) => r.id);
}
