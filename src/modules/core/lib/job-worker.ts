import { db } from "@/lib/db";
import { jobs } from "@/modules/core/schema";
import { eq } from "drizzle-orm";
import { jobQueue } from "./job-queue";
import { agentOrchestrator } from "./agent-orchestrator";
import { logger } from "./logger";

type JobHandler = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

const handlers = new Map<string, JobHandler>();

/**
 * Register a handler for a job type.
 * Convention: each module registers handlers like "catalog.import", "sales.enrich"
 */
export function registerJobHandler(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

// Built-in handler: ShipHero inventory sync (hourly, PST business hours)
registerJobHandler("shiphero.sync-inventory", async () => {
  const { syncShipHeroInventory, isDuringBusinessHours } = await import(
    "@/modules/operations/lib/shiphero/sync-inventory"
  );
  if (!isDuringBusinessHours()) {
    return { skipped: true, reason: "Outside PST business hours" };
  }
  return await syncShipHeroInventory() as unknown as Record<string, unknown>;
});

// Built-in handler: ShipHero order sync (hourly, PST business hours)
registerJobHandler("shiphero.sync-orders", async () => {
  const { syncShipHeroOrders } = await import(
    "@/modules/operations/lib/shiphero/sync-orders"
  );
  const { isDuringBusinessHours } = await import(
    "@/modules/operations/lib/shiphero/sync-inventory"
  );
  if (!isDuringBusinessHours()) {
    return { skipped: true, reason: "Outside PST business hours" };
  }
  return await syncShipHeroOrders() as unknown as Record<string, unknown>;
});

// Built-in handler: run an agent via the orchestrator
registerJobHandler("agent.run", async (input) => {
  const { agentName, agentInput = {} } = input;
  if (!agentName || typeof agentName !== "string") {
    throw new Error("agentName is required for agent.run jobs");
  }
  const output = await agentOrchestrator.runAgentSync(agentName, agentInput as Record<string, unknown>);
  return output as unknown as Record<string, unknown>;
});

let polling = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// Rate limiting: minimum delay between agent calls (ms)
const MIN_AGENT_DELAY_MS = 1000;
let lastAgentCallTime = 0;

/**
 * Recurring schedule mappings to cron-like next run calculation.
 */
function getNextRunTime(recurring: string): string {
  const now = new Date();
  switch (recurring) {
    case "hourly":
      return new Date(now.getTime() + 3600000).toISOString();
    case "daily":
      return new Date(now.getTime() + 86400000).toISOString();
    case "weekly":
      return new Date(now.getTime() + 604800000).toISOString();
    case "monthly":
      return new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()).toISOString();
    default:
      // Cron expression — default to daily if we can't parse
      return new Date(now.getTime() + 86400000).toISOString();
  }
}

/**
 * Process the next available job.
 */
async function processNext(): Promise<boolean> {
  const job = jobQueue.dequeue();
  if (!job) return false;

  const handler = handlers.get(job.type);
  if (!handler) {
    jobQueue.fail(job.id, `No handler registered for job type: ${job.type}`, false);
    logger.logError("warn", "job-worker", `No handler for job type: ${job.type}`);
    return true;
  }

  // Rate limiting for agent jobs
  if (job.type.startsWith("agent.")) {
    const elapsed = Date.now() - lastAgentCallTime;
    if (elapsed < MIN_AGENT_DELAY_MS) {
      await new Promise((r) => setTimeout(r, MIN_AGENT_DELAY_MS - elapsed));
    }
    lastAgentCallTime = Date.now();
  }

  try {
    const input = (job.input as Record<string, unknown>) ?? {};
    const output = await handler(input);
    jobQueue.complete(job.id, output);
    logger.logEvent("job.completed", "core", { jobId: job.id, type: job.type });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    jobQueue.fail(job.id, message);
    logger.logError("error", "job-worker", `Job ${job.id} (${job.type}) failed: ${message}`);
  }

  // If recurring, schedule the next run
  if (job.recurring) {
    const nextRun = getNextRunTime(job.recurring);
    jobQueue.enqueue(job.type, job.module, (job.input as Record<string, unknown>) ?? {}, {
      priority: job.priority,
      scheduledFor: nextRun,
      recurring: job.recurring,
    });
    logger.logEvent("job.recurring.scheduled", "core", {
      type: job.type,
      nextRun,
      recurring: job.recurring,
    });
  }

  return true;
}

/**
 * Start the polling worker. Polls every 5 seconds.
 */
export function startJobWorker(): void {
  if (polling) return;
  polling = true;

  pollTimer = setInterval(async () => {
    try {
      // Process up to 3 jobs per tick
      let processed = 0;
      while (processed < 3) {
        const found = await processNext();
        if (!found) break;
        processed++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.logError("error", "job-worker", `Worker tick error: ${message}`);
    }
  }, 5000);
}

/**
 * Stop the polling worker.
 */
export function stopJobWorker(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  polling = false;
}
