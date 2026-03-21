export const dynamic = "force-dynamic";
/**
 * F8-004: GET /api/v1/customers/reorder-predictions
 */
import { NextRequest, NextResponse } from "next/server";
import { getAllReorderPredictions, predictReorder, type ReorderPrediction } from "@/modules/customers/lib/reorder-engine";

export async function GET(req: NextRequest) {
  const accountId = req.nextUrl.searchParams.get("accountId");
  const filter = req.nextUrl.searchParams.get("status") as ReorderPrediction["reminderStatus"] | null;

  if (accountId) {
    const prediction = predictReorder(accountId);
    if (!prediction) return NextResponse.json({ error: "Account not found" }, { status: 404 });
    return NextResponse.json(prediction);
  }

  const predictions = getAllReorderPredictions(filter ?? undefined);
  return NextResponse.json({
    predictions,
    total: predictions.length,
    summary: {
      overdue: predictions.filter(p => p.reminderStatus === "overdue").length,
      seven_day: predictions.filter(p => p.reminderStatus === "7_day").length,
      fourteen_day: predictions.filter(p => p.reminderStatus === "14_day").length,
    },
  });
}
