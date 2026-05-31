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
 * Skip rule (Daniel: "we shouldn't have to verify twice — we store the
 * status"): once email_verification_status is set, we never re-verify.
 * The single exception is rows currently marked 'error' — that's a
 * transient NeverBounce failure (network / SMTP timeout) and worth one
 * retry next time the operator hits Verify.
 *
 * If you ever need to force re-verification (email changed, you suspect
 * stale data), null out companies.email_verification_status first.
 */

import { sqlite } from "@/lib/db";
import { verifyMany, type NeverBounceResult } from "./client";

export interface VerifyProspectsStats {
  requested: number;
  /** Skipped because already verified (status set, not in retryable
   *  'error' state). Doesn't cost a NeverBounce credit. */
  skippedAlreadyVerified: number;
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
  /** Concurrency for the NeverBounce calls (default 5). */
  concurrency?: number;
  signal?: AbortSignal;
}): Promise<VerifyProspectsStats> {
  const start = Date.now();
  const stats: VerifyProspectsStats = {
    requested: opts.companyIds.length,
    skippedAlreadyVerified: 0,
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

  const placeholders = opts.companyIds.map(() => "?").join(",");
  const rows = sqlite
    .prepare(
      `SELECT id, email, email_verification_status
         FROM companies
        WHERE id IN (${placeholders})`,
    )
    .all(...opts.companyIds) as Array<{
      id: string;
      email: string | null;
      email_verification_status: string | null;
    }>;

  const toVerify: Array<{ id: string; email: string }> = [];
  for (const r of rows) {
    if (!r.email || !r.email.trim()) {
      stats.skippedNoEmail++;
      continue;
    }
    // Skip if already verified to anything besides 'error'. 'error' is
    // a transient NeverBounce failure (network / SMTP timeout) and
    // worth one retry; anything else (valid/catchall/unknown/invalid/
    // disposable) is a real verdict we trust + paid for once.
    if (
      r.email_verification_status &&
      r.email_verification_status !== "error"
    ) {
      stats.skippedAlreadyVerified++;
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
