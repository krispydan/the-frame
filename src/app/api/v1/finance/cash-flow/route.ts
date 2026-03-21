export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { calculateCashFlow } from "@/modules/finance/lib/cash-flow";
import { predictCashFlow } from "@/modules/finance/agents/cash-flow-predictor";

// GET /api/v1/finance/cash-flow?scenario=expected
export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const scenario = params.get("scenario") || "expected";
    const weeksAhead = parseInt(params.get("weeks") || "12");

    const cashFlow = calculateCashFlow();
    const prediction = predictCashFlow(weeksAhead);

    // Apply scenario multipliers to projections
    const scenarioMultipliers: Record<string, { inflow: number; outflow: number }> = {
      optimistic: { inflow: 1.2, outflow: 0.9 },
      expected: { inflow: 1.0, outflow: 1.0 },
      pessimistic: { inflow: 0.7, outflow: 1.15 },
    };
    const mult = scenarioMultipliers[scenario] || scenarioMultipliers.expected;

    let runningBalance = prediction.currentBalance;
    const weeklyProjections = prediction.projections.map((p) => {
      const inflows = Math.round(p.expectedInflows * mult.inflow * 100) / 100;
      const outflows = Math.round(p.expectedOutflows * mult.outflow * 100) / 100;
      // Recalculate balance with scenario adjustments
      runningBalance += inflows - outflows;
      return {
        ...p,
        expectedInflows: inflows,
        expectedOutflows: outflows,
        projectedBalance: Math.round(runningBalance * 100) / 100,
        risk: runningBalance < 0 ? "danger" as const : runningBalance < p.expectedOutflows * 4 ? "tight" as const : "safe" as const,
      };
    });

    // Find projected low point
    const lowPoint = weeklyProjections.reduce((min, p) =>
      p.projectedBalance < min.projectedBalance ? p : min, weeklyProjections[0]);

    // Check if cash goes negative
    const goesNegative = weeklyProjections.some((p) => p.projectedBalance < 0);
    const firstNegativeWeek = weeklyProjections.find((p) => p.projectedBalance < 0);

    return NextResponse.json({
      ...cashFlow,
      scenario,
      prediction: {
        currentBalance: prediction.currentBalance,
        projections: weeklyProjections,
        alerts: prediction.alerts,
        insights: prediction.insights,
        lowPoint: lowPoint ? {
          balance: lowPoint.projectedBalance,
          week: lowPoint.weekLabel,
          weekOffset: lowPoint.weekOffset,
        } : null,
        goesNegative,
        firstNegativeWeek: firstNegativeWeek ? {
          balance: firstNegativeWeek.projectedBalance,
          week: firstNegativeWeek.weekLabel,
          weekOffset: firstNegativeWeek.weekOffset,
        } : null,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
