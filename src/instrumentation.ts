export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startJobWorker } = await import("@/modules/core/lib/job-worker");
    const { jobQueue } = await import("@/modules/core/lib/job-queue");

    // Start the background job worker
    startJobWorker();

    // Seed recurring ShipHero inventory sync (hourly) if not already queued
    const { sqlite } = await import("@/lib/db");
    const existing = sqlite
      .prepare("SELECT 1 FROM jobs WHERE type = ? AND status IN ('pending', 'running') LIMIT 1")
      .get("shiphero.sync-inventory");

    if (!existing) {
      jobQueue.enqueue("shiphero.sync-inventory", "operations", {}, {
        recurring: "hourly",
        priority: 3,
      });
      console.log("[instrumentation] Seeded recurring ShipHero inventory sync (hourly)");
    }

    // Seed recurring ShipHero order sync
    const existingOrderSync = sqlite
      .prepare("SELECT 1 FROM jobs WHERE type = ? AND status IN ('pending', 'running') LIMIT 1")
      .get("shiphero.sync-orders");

    if (!existingOrderSync) {
      jobQueue.enqueue("shiphero.sync-orders", "operations", {}, {
        recurring: "hourly",
        priority: 3,
      });
      console.log("[instrumentation] Seeded recurring ShipHero order sync (hourly)");
    }
  }
}
