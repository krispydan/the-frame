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
import { verifyEmail, type NeverBounceResult } from "./client";

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

  // Inline the concurrency loop instead of using verifyMany() so we can
  // persist each verdict to SQLite the instant it returns from
  // NeverBounce. Previously we batched all results into a single
  // end-of-call transaction — meaning a mid-batch crash (network
  // blip, edge timeout, process restart) would spend up to ~50
  // credits with zero rows updated, and the retry would re-pay for
  // every one. Per-result writes drop that worst case from N to 0
  // wasted credits: every credit spent immediately becomes a stored
  // status that the no-re-verify skip rule will respect on the next
  // run.
  const update = sqlite.prepare(
    `UPDATE companies
        SET email_verification_status = ?,
            email_verified_at         = ?,
            updated_at                = ?
      WHERE id = ?`,
  );

  const concurrency = Math.max(1, Math.min(10, opts.concurrency ?? 5));
  let cursor = 0;

  async function worker() {
    while (cursor < toVerify.length) {
      if (opts.signal?.aborted) return;
      const i = cursor++;
      const { id, email } = toVerify[i];
      try {
        const r = await verifyEmail(email, { signal: opts.signal });
        stats.apiCallsMade++;
        const status = r.result;
        stats.results[status] = (stats.results[status] ?? 0) + 1;
        const now = new Date().toISOString();
        update.run(status, now, now, id);
      } catch (e) {
        // Treat anything that throws (network, 5xx, throttle) as a
        // transient 'error' verdict. Persist it — the
        // `IS NULL OR = 'error'` filter in verify-by-ids will pick it
        // up on the next click, and the original credit (if any was
        // charged) wasn't wasted because we recorded the attempt.
        const msg = e instanceof Error ? e.message : String(e);
        stats.errors.push({ email, message: msg });
        stats.results.error++;
        stats.apiCallsMade++;
        const now = new Date().toISOString();
        update.run("error", now, now, id);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  stats.durationMs = Date.now() - start;
  return stats;
}
