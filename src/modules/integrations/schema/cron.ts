/**
 * Centralized cron scheduler schema.
 *
 * - cron_job_state: per-job runtime state (enabled toggle, last run info,
 *   in-progress flag for concurrency safety). Source of truth for the
 *   "is this job currently running?" question. The job *definitions*
 *   (id, schedule, handler) live in code, not in DB.
 *
 * - cron_runs: one row per job execution. The audit trail / sparkline
 *   data for the UI.
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const cronJobState = sqliteTable("cron_job_state", {
  jobId: text("job_id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastRunId: text("last_run_id"),
  lastRunAt: text("last_run_at"),
  lastStatus: text("last_status"),    // "ok" | "failed" | "skipped"
  lastError: text("last_error"),
  lastDurationMs: integer("last_duration_ms"),
  inProgress: integer("in_progress", { mode: "boolean" }).notNull().default(false),
  inProgressSince: text("in_progress_since"),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

export const cronRuns = sqliteTable("cron_runs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  jobId: text("job_id").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  status: text("status").notNull(),   // "running" | "ok" | "failed" | "skipped"
  durationMs: integer("duration_ms"),
  result: text("result"),             // JSON-serialized output
  error: text("error"),
  triggeredBy: text("triggered_by"),  // "tick" | "manual" | "api"
});

export type CronJobState = typeof cronJobState.$inferSelect;
export type CronRun = typeof cronRuns.$inferSelect;
