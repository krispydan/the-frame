import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { settings } from "@/modules/core/schema";
import { eq } from "drizzle-orm";
import { agentOrchestrator } from "@/modules/core/lib/agent-orchestrator";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/agents/run — Trigger an agent run manually.
 * Body: { agent: string, input?: object }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { agent, input = {} } = body;

    if (!agent || typeof agent !== "string") {
      return NextResponse.json({ error: "agent name is required" }, { status: 400 });
    }

    // Check if agent is disabled
    const enabledKey = `agent_enabled_${agent.replace(/\s+/g, "_").toLowerCase()}`;
    const enabledSetting = db.select().from(settings).where(
      eq(settings.key, enabledKey)
    ).get();

    if (enabledSetting?.value === "false") {
      return NextResponse.json({ error: "Agent is disabled" }, { status: 403 });
    }

    const runId = await agentOrchestrator.runAgent(agent, input);
    return NextResponse.json({ ok: true, runId });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[agents/run] POST error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
