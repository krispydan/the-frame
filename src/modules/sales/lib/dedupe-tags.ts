/**
 * Dedupe the `tags` JSON array on prospect (companies) rows.
 *
 * Historical writers occasionally appended duplicate tags ("ecommerce"
 * appearing 22× on a single prospect, etc.) — current writers all use
 * an `if (!existing.includes(tag))` guard but legacy data persists. This
 * module is the shared cleanup logic, callable from both:
 *   - scripts/dedupe-prospect-tags.ts (one-shot CLI)
 *   - POST /api/v1/sales/prospects/dedupe-tags (admin endpoint)
 *
 * Dedupe rules:
 *   - Case-insensitive comparison ("Vintage" and "vintage" are the same).
 *   - Whitespace trimmed; empty strings dropped.
 *   - Preserves the FIRST occurrence's exact casing in the output.
 *   - Stable order — second/third copies are dropped, original sequence
 *     is otherwise untouched.
 */

import { sqlite } from "@/lib/db";

export interface DedupeRowResult {
  id: string;
  name: string | null;
  before: string[];
  after: string[];
  /** Count of duplicate entries removed (before.length - after.length). */
  removed: number;
}

export interface DedupeRunResult {
  /** Rows with non-null tags considered. */
  scanned: number;
  /** Rows where dedupe actually changed the array. */
  modified: number;
  /** Total duplicate entries removed across all rows. */
  totalRemoved: number;
  /** Per-row results, only for rows that were modified. */
  changes: DedupeRowResult[];
  /** Rows whose tags column couldn't be parsed as a JSON array. */
  malformed: Array<{ id: string; name: string | null; raw: string }>;
}

/**
 * Returns the deduped array. Exposed so callers can preview the result
 * for a single row without committing.
 */
export function dedupeTagsArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Run dedupe across every companies row with a non-null tags column.
 * Only UPDATEs rows where the deduped array actually differs from the
 * original — re-runs are no-ops.
 *
 * @param opts.dryRun  When true, return what would change without
 *                     touching the database.
 */
export function dedupeAllProspectTags(opts?: { dryRun?: boolean }): DedupeRunResult {
  const dryRun = opts?.dryRun ?? false;
  const rows = sqlite
    .prepare(`SELECT id, name, tags FROM companies WHERE tags IS NOT NULL`)
    .all() as Array<{ id: string; name: string | null; tags: string }>;

  const result: DedupeRunResult = {
    scanned: rows.length,
    modified: 0,
    totalRemoved: 0,
    changes: [],
    malformed: [],
  };

  const update = sqlite.prepare(
    `UPDATE companies SET tags = ?, updated_at = datetime('now') WHERE id = ?`,
  );

  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.tags);
    } catch {
      result.malformed.push({ id: row.id, name: row.name, raw: row.tags });
      continue;
    }
    if (!Array.isArray(parsed)) {
      result.malformed.push({ id: row.id, name: row.name, raw: row.tags });
      continue;
    }
    const before = parsed as unknown[];
    const after = dedupeTagsArray(before);
    // Compare carefully — same length AND same string content means no
    // change, even if order shifted (shouldn't, but be safe).
    const unchanged =
      before.length === after.length &&
      before.every((v, i) => typeof v === "string" && v === after[i]);
    if (unchanged) continue;

    const removed = before.length - after.length;
    result.modified += 1;
    result.totalRemoved += removed;
    result.changes.push({
      id: row.id,
      name: row.name,
      before: before.filter((v): v is string => typeof v === "string"),
      after,
      removed,
    });

    if (!dryRun) {
      update.run(JSON.stringify(after), row.id);
    }
  }

  return result;
}
