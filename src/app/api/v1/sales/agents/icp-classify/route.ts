export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { agentOrchestrator } from "@/modules/core/lib/agent-orchestrator";
import "@/modules/sales/agents/icp-classifier"; // registers the agent
import { getUnscoredCompanyIds } from "@/modules/sales/agents/icp-classifier";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  let companyIds = body.companyIds as string[] | undefined;

  // If no IDs provided, classify all unscored
  if (!companyIds || companyIds.length === 0) {
    companyIds = getUnscoredCompanyIds();
    if (companyIds.length === 0) {
      return NextResponse.json({ message: "All companies already classified", processed: 0 });
    }
  }

  // For small batches (<= 100), run synchronously
  if (companyIds.length <= 100) {
    const result = await agentOrchestrator.runAgentSync("icp-classifier", { companyIds });
    return NextResponse.json(result);
  }

  // For large batches, run async
  const runId = await agentOrchestrator.runAgent("icp-classifier", { companyIds });
  return NextResponse.json({
    message: `ICP classification started for ${companyIds.length} companies`,
    runId,
    status: "running",
  });
}

export async function GET(request: NextRequest) {
  const runId = request.nextUrl.searchParams.get("runId");
  if (!runId) {
    // Return unscored count
    const ids = getUnscoredCompanyIds();
    return NextResponse.json({ unscoredCount: ids.length });
  }

  const status = agentOrchestrator.getAgentStatus(runId);
  if (!status) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  return NextResponse.json(status);
}
