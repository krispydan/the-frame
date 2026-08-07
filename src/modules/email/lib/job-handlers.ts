/**
 * Side-effect module — email job handlers, imported once from job-worker.ts
 * (same pattern as marketing's video handlers).
 */
import { registerJobHandler } from "@/modules/core/lib/job-handler-registry";

registerJobHandler("email.send_outbox", async (input): Promise<Record<string, unknown>> => {
  const { dispatchOutbox } = await import("./outbox");
  const res = await dispatchOutbox(String(input.outboxId));
  // 'failed' here is a terminal, human-visible state on the outbox row — the
  // job itself succeeds so the queue doesn't retry a send whose failure is
  // already recorded (a retry could double-send around a 'sending' crash).
  return res as unknown as Record<string, unknown>;
});
