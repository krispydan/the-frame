import { NextRequest, NextResponse } from "next/server";
import { runDemandForecast } from "@/modules/inventory/agents/demand-forecaster";

export async function GET(request: NextRequest) {
  const targetDays = parseInt(request.nextUrl.searchParams.get("targetDays") || "90");

  try {
    const results = runDemandForecast(targetDays);

    return NextResponse.json({
      forecast: results,
      summary: {
        total: results.length,
        critical: results.filter((r) => r.urgencyLevel === "critical").length,
        urgent: results.filter((r) => r.urgencyLevel === "urgent").length,
        watch: results.filter((r) => r.urgencyLevel === "watch").length,
        ok: results.filter((r) => r.urgencyLevel === "ok").length,
        accelerating: results.filter((r) => r.trendDirection === "accelerating").length,
        decelerating: results.filter((r) => r.trendDirection === "decelerating").length,
      },
      targetStockDays: targetDays,
    });
  } catch (error) {
    console.error("Forecast error:", error);
    return NextResponse.json({ error: "Failed to run forecast" }, { status: 500 });
  }
}
