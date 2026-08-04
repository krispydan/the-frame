import { db } from "@/lib/db";
import { jobs } from "@/modules/core/schema";
import { eq, and, lte, lt, or, isNull, asc, sql } from "drizzle-orm";

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
    const strandCutoff = new Date(Date.now() - 15 * 60_000).toISOString();
    const stranded = or(
      isNull(jobs.startedAt),
      lte(jobs.startedAt, strandCutoff),
    );

    // Quarantine poison jobs BEFORE recycling the rest.
    //
    // attempts is incremented when a job is dequeued, but the maxAttempts cap
    // is only ever enforced in fail() — which a job that KILLS THE PROCESS
    // never reaches. So a job heavy enough to OOM the container was recycled
    // here forever: start, dequeue, crash, wait 15 min, repeat, with attempts
    // climbing and nothing reading it. That is a self-sustaining outage, and
    // it's what kept the container crash-looping on 2026-08-04 after the
    // memory cause was fixed.
    //
    // A job that has been picked up maxAttempts times and never reported an
    // outcome has earned the benefit of the doubt running out.
    db
      .update(jobs)
      .set({
        status: "failed",
        error:
          "Stranded in 'running' after maxAttempts pickups without ever reporting an outcome — " +
          "the worker process most likely died executing it. Quarantined so it cannot crash-loop the queue.",
        completedAt: new Date().toISOString(),
      })
      .where(and(eq(jobs.status, "running"), stranded, sql`${jobs.attempts} >= ${jobs.maxAttempts}`))
      .run();

    db
      .update(jobs)
      .set({ status: "pending", startedAt: null })
      .where(and(eq(jobs.status, "running"), stranded))
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
      // Belt and braces with the quarantine above: never hand out a job that
      // has already used its attempts, whatever put it back in 'pending'.
      lt(jobs.attempts, jobs.maxAttempts),
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
