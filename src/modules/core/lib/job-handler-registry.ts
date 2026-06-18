/**
 * Job handler registry.
 *
 * Extracted from job-worker.ts to break a circular import:
 *
 *   job-worker.ts  ──eagerly imports──>  status-sync.ts
 *   status-sync.ts ──imports registerJobHandler──> job-worker.ts   ← cycle
 *
 * Cycle triggered a TDZ at server startup ("Cannot access 'g' before
 * initialization" — 'g' was the minified registerJobHandler) which
 * brought the app down on every deploy after 76ea9f8 + 1d3786e.
 *
 * Now: both files import from THIS module instead. No cycle.
 * job-worker still owns the polling loop + worker lifecycle; this
 * module is JUST the handler map + register/get helpers.
 */

export type JobHandler = (
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

const handlers = new Map<string, JobHandler>();

/**
 * Register a handler for a job type.
 * Convention: `<module>.<verb>` — e.g. "catalog.import", "sales.enrich",
 * "sales.sync_status_to_instantly".
 */
export function registerJobHandler(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

/** Look up a previously-registered handler. Returns undefined if none. */
export function getJobHandler(type: string): JobHandler | undefined {
  return handlers.get(type);
}

/** All registered job types — useful for diagnostics. */
export function listJobHandlers(): string[] {
  return Array.from(handlers.keys());
}
