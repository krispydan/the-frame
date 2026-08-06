/**
 * MCP tools for the sequence engine, so it can be driven from a Claude session
 * the same way the rest of the frame is — inspect the queue, enrol an account,
 * check how a sequence is doing, run a tick.
 *
 * Deliberately absent: anything that SENDS. The queue is cleared by a human or
 * by the runner; a chat session should be able to see and schedule outreach,
 * not fire it.
 */

import { z } from "zod";
import { mcpRegistry } from "@/modules/core/mcp/server";
import { sqlite } from "@/lib/db";
import { getQueue, queueCounts } from "../lib/queue";
import { sequenceMetrics, sequenceEnrollments } from "../lib/metrics";
import { enrollOne, enrollMany } from "../lib/enroll";
import { runTick } from "../lib/engine";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

mcpRegistry.register(
  "sequences.list",
  "List outreach sequences with their status, steps and performance",
  z.object({}),
  async () => {
    const rows = sqlite
      .prepare("SELECT id, name, brand, trigger, status, enrollment_mode, propose_only FROM sequences ORDER BY priority DESC")
      .all() as Array<{ id: string; name: string }>;
    return ok({
      engineEnabled: (sqlite.prepare("SELECT value FROM settings WHERE key='seq.engine_enabled'").get() as { value: string } | undefined)?.value === "true",
      sequences: rows.map((r) => ({ ...r, metrics: sequenceMetrics(r.id) })),
      queue: queueCounts(),
    });
  },
);

mcpRegistry.register(
  "sequences.queue",
  "Show the outreach review queue — messages drafted and waiting for a human to send",
  z.object({
    limit: z.number().optional().describe("Max items (default 25)"),
    brand: z.string().optional().describe("Filter by brand: ajm or jaxy"),
  }),
  async ({ limit, brand }) => ok({ counts: queueCounts(), items: getQueue({ limit: limit ?? 25, brand }) }),
);

mcpRegistry.register(
  "sequences.enroll",
  "Enrol one company, or many, into a sequence. Honours suppression and cooldowns.",
  z.object({
    sequenceId: z.string().describe("Sequence id"),
    companyId: z.string().optional().describe("Single company id"),
    companyIds: z.array(z.string()).optional().describe("Several company ids"),
    dryRun: z.boolean().optional().describe("Preview only, write nothing"),
  }),
  async ({ sequenceId, companyId, companyIds, dryRun }) => {
    if (companyId) return ok(enrollOne(sequenceId, companyId, { by: "mcp" }));
    if (companyIds?.length) return ok(enrollMany(sequenceId, companyIds, { by: "mcp", dryRun }));
    return { content: [{ type: "text" as const, text: "companyId or companyIds is required" }], isError: true };
  },
);

mcpRegistry.register(
  "sequences.detail",
  "Show one sequence: its steps, metrics and who is currently enrolled",
  z.object({ sequenceId: z.string().describe("Sequence id") }),
  async ({ sequenceId }) => {
    const seq = sqlite.prepare("SELECT * FROM sequences WHERE id = ?").get(sequenceId);
    if (!seq) return { content: [{ type: "text" as const, text: "no such sequence" }], isError: true };
    return ok({
      sequence: seq,
      steps: sqlite.prepare("SELECT step_no, delay_days, channel, send_mode, template_body FROM sequence_steps WHERE sequence_id=? ORDER BY step_no").all(sequenceId),
      metrics: sequenceMetrics(sequenceId),
      enrollments: sequenceEnrollments(sequenceId, 25),
    });
  },
);

mcpRegistry.register(
  "sequences.tick",
  "Run the sequence engine tick (dry run supported). Queues messages; never sends.",
  z.object({ dryRun: z.boolean().optional().describe("Evaluate without writing") }),
  async ({ dryRun }) => ok(runTick({ dryRun: !!dryRun })),
);

export const sequencesMcpToolNames = [
  "sequences.list", "sequences.queue", "sequences.enroll", "sequences.detail", "sequences.tick",
];
