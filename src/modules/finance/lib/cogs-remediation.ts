/**
 * One-off remediation: strip the duplicated COGS from the OLD Stage-2
 * revenue-recognition journals.
 *
 * Before the daily FIFO COGS system, the shipment-revenue-recognition job
 * posted ONE Manual Journal per order containing BOTH revenue recognition
 * (DR 2050 / CR 4030|4040) AND a per-order COGS pair at catalog cost
 * (DR 5000 / CR 1400). COGS is now owned by the FIFO daily job, so those
 * embedded COGS lines double-count. This re-posts each affected journal
 * revenue-only — removing just the COGS pair, leaving revenue (and its
 * tracking) exactly as Xero has it.
 *
 * Idempotent: zeroes order_revenue_recognitions.cogs_amount after a successful
 * strip, so re-runs skip it. Dry-run does GETs only — no writes, no Xero edits.
 */
import { sqlite } from "@/lib/db";
import { xeroAdminFetch, xeroAdminPost } from "./xero-client";

/** Account codes that make up the duplicated COGS pair in the old journals. */
export const COGS_PAIR_CODES = ["5000", "1400"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run a Xero call, backing off on 429 (Xero's 60 calls/min limit). Fixed
 *  escalating delays since xeroAdminFetch/Post don't surface Retry-After. */
async function withRetry<T extends { success: boolean; error?: string }>(
  fn: () => Promise<T>,
  attempts = 5,
): Promise<T> {
  let last!: T;
  for (let i = 0; i < attempts; i++) {
    last = await fn();
    if (last.success || !/(^|\D)429(\D|$)/.test(last.error || "")) return last;
    await sleep([3000, 8000, 15000, 25000][i] ?? 25000);
  }
  return last;
}

interface XeroJournalLine {
  LineAmount: number;
  AccountCode: string;
  Description?: string;
  Tracking?: unknown;
}

/** Split a journal's lines into the COGS pair (to drop) and the rest (to keep). */
export function splitCogsLines(
  lines: XeroJournalLine[],
  cogsCodes: string[] = COGS_PAIR_CODES,
): { cogsLines: XeroJournalLine[]; keepLines: XeroJournalLine[] } {
  const cogsLines: XeroJournalLine[] = [];
  const keepLines: XeroJournalLine[] = [];
  for (const l of lines) {
    (cogsCodes.includes(String(l.AccountCode)) ? cogsLines : keepLines).push(l);
  }
  return { cogsLines, keepLines };
}

export interface RemediationResult {
  dryRun: boolean;
  candidates: number;
  stripped: number;
  alreadyClean: number;
  errors: Array<{ orderId: string; journalId: string | null; error: string }>;
  cogsRemoved: number;
}

export async function stripCogsFromOldRecognitions(
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<RemediationResult> {
  const dryRun = opts.dryRun !== false; // default DRY — must pass dryRun:false to write
  const res: RemediationResult = { dryRun, candidates: 0, stripped: 0, alreadyClean: 0, errors: [], cogsRemoved: 0 };

  const rows = sqlite.prepare(`
    SELECT order_id AS orderId, xero_manual_journal_id AS journalId, cogs_amount AS cogs
    FROM order_revenue_recognitions
    WHERE cogs_amount > 0 AND xero_manual_journal_id IS NOT NULL
    ORDER BY recognized_at ASC
    ${opts.limit ? `LIMIT ${Number(opts.limit)}` : ""}
  `).all() as Array<{ orderId: string; journalId: string; cogs: number }>;
  res.candidates = rows.length;

  for (const r of rows) {
    try {
      // Throttle to stay under Xero's 60 calls/min (2 calls/journal → ~54/min).
      await sleep(2200);
      const get = await withRetry(() => xeroAdminFetch(`/api.xro/2.0/ManualJournals/${r.journalId}`));
      if (!get.success) { res.errors.push({ orderId: r.orderId, journalId: r.journalId, error: get.error }); continue; }
      const mj = (get.data as { ManualJournals?: Array<Record<string, unknown>> }).ManualJournals?.[0];
      if (!mj) { res.errors.push({ orderId: r.orderId, journalId: r.journalId, error: "journal not found in Xero" }); continue; }

      const lines = (mj.JournalLines as XeroJournalLine[]) || [];
      const { cogsLines, keepLines } = splitCogsLines(lines);

      if (cogsLines.length === 0) {
        // Already revenue-only in Xero — just mark it clean locally.
        res.alreadyClean++;
        if (!dryRun) sqlite.prepare("UPDATE order_revenue_recognitions SET cogs_amount = 0 WHERE order_id = ?").run(r.orderId);
        continue;
      }

      res.cogsRemoved += cogsLines.filter((l) => l.LineAmount > 0).reduce((s, l) => s + l.LineAmount, 0);
      if (dryRun) { res.stripped++; continue; }

      // Re-post the SAME journal with only the revenue lines. Including the
      // ManualJournalID updates in place; signs/tracking are preserved verbatim.
      const narration = String(mj.Narration || "").replace(/\s*\|\s*COGS[^|]*/i, "").trim()
        || `Revenue recognition (COGS moved to FIFO subledger)`;
      const update = await withRetry(() => xeroAdminPost("/api.xro/2.0/ManualJournals", {
        ManualJournals: [{
          ManualJournalID: r.journalId,
          Narration: narration,
          Date: mj.Date,
          Status: "POSTED",
          JournalLines: keepLines.map((l) => ({
            LineAmount: l.LineAmount,
            AccountCode: l.AccountCode,
            Description: l.Description,
            ...(l.Tracking ? { Tracking: l.Tracking } : {}),
          })),
        }],
      }));
      if (!update.success) { res.errors.push({ orderId: r.orderId, journalId: r.journalId, error: update.error }); continue; }

      sqlite.prepare("UPDATE order_revenue_recognitions SET cogs_amount = 0 WHERE order_id = ?").run(r.orderId);
      res.stripped++;
    } catch (e) {
      res.errors.push({ orderId: r.orderId, journalId: r.journalId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  res.cogsRemoved = Math.round(res.cogsRemoved * 100) / 100;
  return res;
}
