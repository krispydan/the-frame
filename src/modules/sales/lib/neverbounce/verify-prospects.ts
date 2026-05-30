/**
 * Bulk-verify a list of prospect emails via NeverBounce and persist the
 * result onto the companies row. Just-in-time verification before the
 * Instantly push step (Daniel's choice — saves credits vs verifying
 * every CSV import).
 *
 * Each row is updated with:
 *   email_verification_status — the raw NeverBounce `result` ('valid' /
 *                                'catchall' / 'unknown' / 'invalid' /
 *                                'disposable' / 'error')
 *   email_verified_at         — ISO timestamp of this verification
 *
 * Skips rows verified within the staleness window (90 days by default)
 * — NeverBounce charges per call and re-verifying a fresh address is
 * wasteful.
 */

import { sqlite } from "@/lib/db";
import { verifyMany, type NeverBounceResult } from "./client";

const VERIFICATION_TTL_DAYS = 90;

export interface VerifyProspectsStats {
  requested: number;
  /** Skipped because verified within the TTL window. */
  skippedFresh: number;
  /** Skipped because email field was null/empty. */
  skippedNoEmail: number;
  /** Count of API calls made (= chargeable credits). */
  apiCallsMade: number;
  /** Per-status breakdown of the writes from this run. */
  results: Record<NeverBounceResult | "error", number>;
  /** API failures keyed by email — partial-success path. */
  errors: Array<{ email: string; message: string }>;
  durationMs: number;
}

const ZERO_RESULTS = (): VerifyProspectsStats["results"] => ({
  valid: 0,
  catchall: 0,
  unknown: 0,
  invalid: 0,
  disposable: 0,
  error: 0,
});

export async function verifyProspectEmails(opts: {
  companyIds: string[];
  /** Override the staleness TTL (default 90 days). */
  ttlDays?: number;
  /** Concurrency for the NeverBounce calls (default 5). */
  concurrency?: number;
  signal?: AbortSignal;
}): Promise<VerifyProspectsStats> {
  const start = Date.now();
  const stats: VerifyProspectsStats = {
    requested: opts.companyIds.length,
    skippedFresh: 0,
    skippedNoEmail: 0,
    apiCallsMade: 0,
    results: ZERO_RESULTS(),
    errors: [],
    durationMs: 0,
  };
  if (opts.companyIds.length === 0) {
    stats.durationMs = Date.now() - start;
    return stats;
  }

  const ttlMs = (opts.ttlDays ?? VERIFICATION_TTL_DAYS) * 24 * 60 * 60 * 1000;
  const freshThreshold = new Date(Date.now() - ttlMs).toISOString();

  const placeholders = opts.companyIds.map(() => "?").join(",");
  const rows = sqlite
    .prepare(
      `SELECT id, email, email_verification_status, email_verified_at
         FROM companies
        WHERE id IN (${placeholders})`,
    )
    .all(...opts.companyIds) as Array<{
      id: string;
      email: string | null;
      email_verification_status: string | null;
      email_verified_at: string | null;
    }>;

  const toVerify: Array<{ id: string; email: string }> = [];
  for (const r of rows) {
    if (!r.email || !r.email.trim()) {
      stats.skippedNoEmail++;
      continue;
    }
    if (
      r.email_verification_status &&
      r.email_verified_at &&
      r.email_verified_at > freshThreshold
    ) {
      stats.skippedFresh++;
      continue;
    }
    toVerify.push({ id: r.id, email: r.email.trim().toLowerCase() });
  }

  if (toVerify.length === 0) {
    stats.durationMs = Date.now() - start;
    return stats;
  }

  const map = await verifyMany(toVerify.map((t) => t.email), {
    concurrency: opts.concurrency,
    signal: opts.signal,
  });
  stats.apiCallsMade = Object.keys(map).length;

  const update = sqlite.prepare(
    `UPDATE companies
        SET email_verification_status = ?,
            email_verified_at         = ?,
            updated_at                = ?
      WHERE id = ?`,
  );
  const now = new Date().toISOString();

  const txn = sqlite.transaction(() => {
    for (const { id, email } of toVerify) {
      const r = map[email];
      if (!r) continue;
      if ("error" in r) {
        stats.errors.push({ email, message: r.error });
        stats.results.error++;
        update.run("error", now, now, id);
        continue;
      }
      const status = r.result;
      stats.results[status] = (stats.results[status] ?? 0) + 1;
      update.run(status, now, now, id);
    }
  });
  txn();

  stats.durationMs = Date.now() - start;
  return stats;
}
