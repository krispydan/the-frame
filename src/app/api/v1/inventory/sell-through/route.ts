export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { calculateSellThrough, getReorderRecommendations } from "@/modules/inventory/lib/sell-through";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const windowDays = parseInt(params.get("window") || "30");
  const reorderOnly = params.get("reorder") === "true";
  const targetDays = parseInt(params.get("targetDays") || "90");

  try {
    if (reorderOnly) {
      const recommendations = getReorderRecommendations(targetDays);
      return NextResponse.json({
        recommendations,
        count: recommendations.length,
        targetStockDays: targetDays,
      });
    }

    const results = calculateSellThrough(windowDays);
    return NextResponse.json({
      items: results,
      count: results.length,
      windowDays,
      summary: {
        fastMovers: results.filter((r) => r.velocity === "fast").length,
        normalMovers: results.filter((r) => r.velocity === "normal").length,
        slowMovers: results.filter((r) => r.velocity === "slow").length,
        deadStock: results.filter((r) => r.velocity === "dead").length,
        needsReorder: results.filter((r) => r.needsReorder).length,
        outOfStock: results.filter((r) => r.currentStock === 0).length,
      },
    });
  } catch (error) {
    console.error("Sell-through API error:", error);
    return NextResponse.json({ error: "Failed to calculate sell-through" }, { status: 500 });
  }
}
