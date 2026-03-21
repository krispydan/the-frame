export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { calculatePnl, type PnlPeriod } from "@/modules/finance/lib/pnl";

// GET /api/v1/finance/pnl
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const period = (url.searchParams.get("period") || "mtd") as PnlPeriod;
  const customStart = url.searchParams.get("start") || undefined;
  const customEnd = url.searchParams.get("end") || undefined;

  try {
    const pnl = calculatePnl(period, customStart, customEnd);
    return NextResponse.json(pnl);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
