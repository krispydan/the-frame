import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentRuns, jobs, settings } from "@/modules/core/schema";
import { sql, eq, desc } from "drizzle-orm";
import { agentOrchestrator } from "@/modules/core/lib/agent-orchestrator";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/agents — List registered agents with stats from agent_runs + jobs.
 */
export async function GET() {
  try {
    const registered = agentOrchestrator.listAgents();

    // Agent run stats: last run, total runs, success count, total tokens, total cost
    const runStats = db
      .select({
        agentName: agentRuns.agentName,
        totalRuns: sql<number>`count(*)`,
        successCount: sql<number>`sum(case when ${agentRuns.status} = 'completed' then 1 else 0 end)`,
        failedCount: sql<number>`sum(case when ${agentRuns.status} = 'failed' then 1 else 0 end)`,
        totalTokens: sql<number>`coalesce(sum(${agentRuns.tokensUsed}), 0)`,
        totalCost: sql<number>`coalesce(sum(${agentRuns.cost}), 0)`,
        lastRunAt: sql<string>`max(${agentRuns.createdAt})`,
        lastStatus: sql<string>`(select status from agent_runs ar2 where ar2.agent_name = ${agentRuns.agentName} order by created_at desc limit 1)`,
      })
      .from(agentRuns)
      .groupBy(agentRuns.agentName)
      .all();

    const statsMap = new Map(runStats.map((s) => [s.agentName, s]));

    // Agent enabled/disabled from settings (key: agent_enabled_<name>)
    const enabledSettings = db
      .select()
      .from(settings)
      .where(sql`${settings.key} like 'agent_enabled_%'`)
      .all();
    const enabledMap = new Map(enabledSettings.map((s) => [s.key, s.value]));

    // Recent runs (last 50)
    const recentRuns = db
      .select()
      .from(agentRuns)
      .orderBy(desc(agentRuns.createdAt))
      .limit(50)
      .all();

    // Job queue summary
    const jobStats = db
      .select({
        status: jobs.status,
        count: sql<number>`count(*)`,
      })
      .from(jobs)
      .groupBy(jobs.status)
      .all();

    const jobQueue = db
      .select()
      .from(jobs)
      .where(sql`${jobs.status} in ('pending', 'running')`)
      .orderBy(desc(jobs.createdAt))
      .limit(20)
      .all();

    // Token usage totals
    const tokenTotals = db
      .select({
        totalTokens: sql<number>`coalesce(sum(${agentRuns.tokensUsed}), 0)`,
        totalCost: sql<number>`coalesce(sum(${agentRuns.cost}), 0)`,
      })
      .from(agentRuns)
      .get();

    const agents = registered.map((a) => {
      const stats = statsMap.get(a.name);
      const enabledKey = `agent_enabled_${a.name.replace(/\s+/g, "_").toLowerCase()}`;
      const enabledVal = enabledMap.get(enabledKey);
      return {
        name: a.name,
        module: a.module,
        config: a.config,
        enabled: enabledVal !== "false", // default enabled
        totalRuns: stats?.totalRuns ?? 0,
        successCount: stats?.successCount ?? 0,
        failedCount: stats?.failedCount ?? 0,
        totalTokens: stats?.totalTokens ?? 0,
        totalCost: stats?.totalCost ?? 0,
        lastRunAt: stats?.lastRunAt ?? null,
        lastStatus: stats?.lastStatus ?? null,
      };
    });

    return NextResponse.json({
      agents,
      recentRuns,
      jobQueue,
      jobStats: Object.fromEntries(jobStats.map((j) => [j.status, j.count])),
      tokenTotals: {
        totalTokens: tokenTotals?.totalTokens ?? 0,
        totalCostCents: tokenTotals?.totalCost ?? 0,
      },
    });
  } catch (error) {
    console.error("[agents] GET error:", error);
    return NextResponse.json({ error: "Failed to fetch agents" }, { status: 500 });
  }
}
