/**
 * Cron scheduler core. Orchestrates job runs across the in-code registry
 * + the cron_job_state / cron_runs tables.
 *
 * Two entry points:
 *   tick(now?)          run every minute by Railway cron — looks at
 *                       schedules, runs anything due
 *   runJob(id, "manual")  trigger a single job from the UI / API
 */

import { db, sqlite } from "@/lib/db";
import { cronJobState, cronRuns, type CronRun } from "@/modules/integrations/schema/cron";
import { eq } from "drizzle-orm";
import { CRON_JOBS, findJob, type CronJob } from "./registry";
import { matches, parseCron } from "./expression";

export type RunResult = {
  jobId: string;
  status: "ok" | "failed" | "skipped";
  durationMs: number;
  result?: unknown;
  error?: string;
};

/** How long an in-progress lock is honoured before being considered stale. */
const STALE_LOCK_MS = 15 * 60 * 1000;  // 15 min

async function ensureStateRow(jobId: string): Promise<void> {
  const existing = sqlite.prepare("SELECT job_id FROM cron_job_state WHERE job_id = ?").get(jobId);
  if (!existing) {
    sqlite.prepare(
      "INSERT OR IGNORE INTO cron_job_state (job_id, enabled) VALUES (?, 1)"
    ).run(jobId);
  }
}

function isLockStale(inProgressSince: string | null | undefined): boolean {
  if (!inProgressSince) return true;
  return Date.now() - new Date(inProgressSince).getTime() > STALE_LOCK_MS;
}

async function tryAcquireLock(jobId: string): Promise<boolean> {
  await ensureStateRow(jobId);
  // Atomic: only flip in_progress if not already in progress (or stale).
  const result = sqlite.prepare(`
    UPDATE cron_job_state
    SET in_progress = 1,
        in_progress_since = datetime('now'),
        updated_at = datetime('now')
    WHERE job_id = ?
      AND (in_progress = 0 OR in_progress_since < datetime('now', '-15 minutes'))
  `).run(jobId);
  return (result.changes ?? 0) > 0;
}

async function releaseLock(jobId: string, run: { runId: string; status: string; error: string | null; durationMs: number }): Promise<void> {
  sqlite.prepare(`
    UPDATE cron_job_state SET
      in_progress = 0,
      in_progress_since = NULL,
      last_run_id = ?,
      last_run_at = datetime('now'),
      last_status = ?,
      last_error = ?,
      last_duration_ms = ?,
      updated_at = datetime('now')
    WHERE job_id = ?
  `).run(run.runId, run.status, run.error, run.durationMs, jobId);
}

/**
 * Execute a single job, taking the lock + recording a cron_runs row.
 * Returns the run result.
 */
export async function runJob(jobId: string, triggeredBy: "tick" | "manual" | "api" = "manual"): Promise<RunResult> {
  const job = findJob(jobId);
  if (!job) return { jobId, status: "failed", durationMs: 0, error: `Unknown job: ${jobId}` };

  // Concurrency lock
  const acquired = await tryAcquireLock(jobId);
  if (!acquired) {
    return { jobId, status: "skipped", durationMs: 0, error: "already in progress" };
  }

  // Open the run row
  const startedAt = new Date().toISOString();
  const [runRow] = await db.insert(cronRuns).values({
    jobId,
    startedAt,
    status: "running",
    triggeredBy,
  }).returning();
  const runId = runRow.id;
  const start = Date.now();

  try {
    // Optional guard
    if (job.guard) {
      const allowed = await job.guard();
      if (!allowed) {
        const durationMs = Date.now() - start;
        await db.update(cronRuns).set({
          finishedAt: new Date().toISOString(),
          status: "skipped",
          durationMs,
          error: "guard returned false",
        }).where(eq(cronRuns.id, runId));
        await releaseLock(jobId, { runId, status: "skipped", error: null, durationMs });
        return { jobId, status: "skipped", durationMs, error: "guard returned false" };
      }
    }

    // Execute
    const result = await job.handler();
    const durationMs = Date.now() - start;
    await db.update(cronRuns).set({
      finishedAt: new Date().toISOString(),
      status: "ok",
      durationMs,
      result: JSON.stringify(result ?? null).slice(0, 8000),
    }).where(eq(cronRuns.id, runId));
    await releaseLock(jobId, { runId, status: "ok", error: null, durationMs });
    return { jobId, status: "ok", durationMs, result };
  } catch (err) {
    const durationMs = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);
    await db.update(cronRuns).set({
      finishedAt: new Date().toISOString(),
      status: "failed",
      durationMs,
      error,
    }).where(eq(cronRuns.id, runId));
    await releaseLock(jobId, { runId, status: "failed", error, durationMs });
    console.error(`[cron] ${jobId} failed:`, err);
    return { jobId, status: "failed", durationMs, error };
  }
}

/**
 * One scheduler tick. Runs every minute.
 * Skips disabled jobs and any whose schedule doesn't match `now`.
 * Runs eligible jobs in parallel.
 */
export async function tick(now: Date = new Date()): Promise<{ ranJobs: RunResult[]; skipped: number }> {
  const states = sqlite.prepare(
    "SELECT job_id, enabled FROM cron_job_state"
  ).all() as Array<{ job_id: string; enabled: number }>;
  const enabledByJob = new Map(states.map((s) => [s.job_id, !!s.enabled]));

  const eligible: CronJob[] = [];
  for (const job of CRON_JOBS) {
    // Defaults: enabled if no row yet (jobs are enabled by default unless
    // the registry says otherwise).
    const enabled = enabledByJob.has(job.id)
      ? enabledByJob.get(job.id)!
      : job.defaultEnabled !== false;
    if (!enabled) continue;

    let parsed;
    try {
      parsed = parseCron(job.schedule);
    } catch (e) {
      console.error(`[cron] ${job.id} has invalid schedule "${job.schedule}":`, e);
      continue;
    }
    if (!matches(parsed, now)) continue;

    eligible.push(job);
  }

  if (eligible.length === 0) return { ranJobs: [], skipped: 0 };

  // Run in parallel — each handles its own DB writes + lock
  const results = await Promise.all(eligible.map((j) => runJob(j.id, "tick")));
  const ran = results.filter((r) => r.status !== "skipped");
  const skipped = results.length - ran.length;
  return { ranJobs: ran, skipped };
}

/** Read-only view of all jobs + their state, for the UI. */
export type JobSummary = {
  id: string;
  schedule: string;
  description: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  inProgress: boolean;
  recentRuns: Array<Pick<CronRun, "id" | "startedAt" | "status" | "durationMs" | "error">>;
};

export async function listJobs(opts: { recentRunCount?: number } = {}): Promise<JobSummary[]> {
  const recentCount = opts.recentRunCount ?? 5;
  const states = sqlite.prepare("SELECT * FROM cron_job_state").all() as Array<{
    job_id: string;
    enabled: number;
    last_run_at: string | null;
    last_status: string | null;
    last_error: string | null;
    last_duration_ms: number | null;
    in_progress: number;
  }>;
  const stateByJob = new Map(states.map((s) => [s.job_id, s]));

  const summaries: JobSummary[] = [];
  for (const job of CRON_JOBS) {
    const s = stateByJob.get(job.id);
    const recentRuns = sqlite.prepare(
      "SELECT id, started_at, status, duration_ms, error FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?",
    ).all(job.id, recentCount) as Array<{
      id: string;
      started_at: string;
      status: string;
      duration_ms: number | null;
      error: string | null;
    }>;
    summaries.push({
      id: job.id,
      schedule: job.schedule,
      description: job.description,
      enabled: s ? !!s.enabled : (job.defaultEnabled !== false),
      lastRunAt: s?.last_run_at ?? null,
      lastStatus: s?.last_status ?? null,
      lastError: s?.last_error ?? null,
      lastDurationMs: s?.last_duration_ms ?? null,
      inProgress: !!s?.in_progress,
      recentRuns: recentRuns.map((r) => ({
        id: r.id,
        startedAt: r.started_at,
        status: r.status,
        durationMs: r.duration_ms,
        error: r.error,
      })),
    });
  }
  return summaries;
}

export async function setJobEnabled(jobId: string, enabled: boolean): Promise<void> {
  await ensureStateRow(jobId);
  sqlite.prepare(
    "UPDATE cron_job_state SET enabled = ?, updated_at = datetime('now') WHERE job_id = ?"
  ).run(enabled ? 1 : 0, jobId);
}

// silence unused import warning if registry shrinks
void STALE_LOCK_MS;
void isLockStale;
