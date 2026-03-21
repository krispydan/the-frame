export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { calculateCashFlow } from "@/modules/finance/lib/cash-flow";

// GET /api/v1/finance/cash-flow
export async function GET() {
  try {
    const cashFlow = calculateCashFlow();
    return NextResponse.json(cashFlow);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
