/**
 * F8-003: GET /api/v1/customers/health
 * Returns health summary and optionally recalculates scores.
 */
import { NextRequest, NextResponse } from "next/server";
import { getHealthSummary, recalculateAllHealthScores } from "@/modules/customers/lib/health-scoring";

export async function GET(req: NextRequest) {
  const recalc = req.nextUrl.searchParams.get("recalculate") === "true";

  if (recalc) {
    const result = recalculateAllHealthScores();
    return NextResponse.json({ recalculated: result.updated, summary: getHealthSummary() });
  }

  return NextResponse.json(getHealthSummary());
}
