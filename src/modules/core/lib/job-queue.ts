import { db } from "@/lib/db";
import { jobs } from "@/modules/core/schema";
import { eq, and, lte, or, isNull, asc, sql } from "drizzle-orm";

export interface EnqueueOptions {
  priority?: number; // 1 = highest, 3 = lowest (default 2)
  scheduledFor?: string; // ISO datetime
  recurring?: string; // cron expression
}

export class JobQueue {
  /**
   * Add a job to the queue.
   */
  enqueue(
    type: string,
    module: string,
    input: Record<string, unknown>,
    options: EnqueueOptions = {}
  ): string {
    const id = crypto.randomUUID();
    db.insert(jobs)
      .values({
        id,
        type,
        module,
        input,
        priority: options.priority ?? 2,
        scheduledFor: options.scheduledFor ?? null,
        recurring: options.recurring ?? null,
        status: "pending",
        attempts: 0,
        maxAttempts: 3,
      })
      .run();
    return id;
  }

  /**
   * Get the next job to process. Marks it as running.
   * Respects priority (1 first), scheduled time, and max concurrent (3).
   */
  dequeue(module?: string): typeof jobs.$inferSelect | null {
    // Self-heal stuck jobs. A server restart mid-job (frequent — every
    // deploy) strands rows in 'running' forever. The concurrency guard
    // below (>= 3 running → bail) then jams the ENTIRE queue: once 3
    // stale 'running' rows accumulate, no pending job ever runs again.
    // (Prod jam observed 2026-06-22 → 2026-07-01; a shiphero job was
    // "running" for 13.8 days.) Reset any 'running' job whose started_at
    // is older than 15 min back to 'pending' so it — and the queue —
    // recover automatically.
    db
      .update(jobs)
      .set({ status: "pending", startedAt: null })
      .where(
        and(
          eq(jobs.status, "running"),
          or(
            isNull(jobs.startedAt),
            lte(jobs.startedAt, new Date(Date.now() - 15 * 60_000).toISOString()),
          ),
        ),
      )
      .run();

    // Check concurrent running jobs
    const running = db
      .select({ count: sql<number>`count(*)` })
      .from(jobs)
      .where(eq(jobs.status, "running"))
      .get();

    if (running && running.count >= 3) return null;

    const now = new Date().toISOString();
    const conditions = [
      eq(jobs.status, "pending"),
      or(isNull(jobs.scheduledFor), lte(jobs.scheduledFor, now)),
    ];

    if (module) {
      conditions.push(eq(jobs.module, module));
    }

    const job = db
      .select()
      .from(jobs)
      .where(and(...conditions))
      .orderBy(asc(jobs.priority), asc(jobs.createdAt))
      .limit(1)
      .get();

    if (!job) return null;

    // Mark as running
    db.update(jobs)
      .set({
        status: "running",
        startedAt: now,
        attempts: job.attempts + 1,
      })
      .where(eq(jobs.id, job.id))
      .run();

    return { ...job, status: "running", startedAt: now, attempts: job.attempts + 1 };
  }

  /**
   * Mark a job as completed.
   */
  complete(jobId: string, output: Record<string, unknown> = {}): void {
    db.update(jobs)
      .set({
        status: "completed",
        output,
        completedAt: new Date().toISOString(),
      })
      .where(eq(jobs.id, jobId))
      .run();
  }

  /**
   * Mark a job as failed. Optionally retry (resets to pending with backoff).
   */
  fail(jobId: string, error: string, shouldRetry = true): void {
    const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (!job) return;

    if (shouldRetry && job.attempts < job.maxAttempts) {
      // Exponential backoff: 5s, 25s, 125s
      const backoffMs = Math.pow(5, job.attempts) * 1000;
      const scheduledFor = new Date(Date.now() + backoffMs).toISOString();

      db.update(jobs)
        .set({
          status: "pending",
          error,
          scheduledFor,
        })
        .where(eq(jobs.id, jobId))
        .run();
    } else {
      db.update(jobs)
        .set({
          status: "failed",
          error,
          completedAt: new Date().toISOString(),
        })
        .where(eq(jobs.id, jobId))
        .run();
    }
  }

  /**
   * Get job status by ID.
   */
  getStatus(jobId: string): typeof jobs.$inferSelect | null {
    return db.select().from(jobs).where(eq(jobs.id, jobId)).get() ?? null;
  }
}

export const jobQueue = new JobQueue();
