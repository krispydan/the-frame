export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { calculatePnl, pnlToCsv, type PnlPeriod } from "@/modules/finance/lib/pnl";

// GET /api/v1/finance/pnl
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const period = (url.searchParams.get("period") || "mtd") as PnlPeriod;
  const customStart = url.searchParams.get("start") || undefined;
  const customEnd = url.searchParams.get("end") || undefined;
  const format = url.searchParams.get("format"); // "csv" for export

  try {
    const pnl = calculatePnl(period, customStart, customEnd);

    if (format === "csv") {
      const csv = pnlToCsv(pnl);
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="pnl-${pnl.period.start}-to-${pnl.period.end}.csv"`,
        },
      });
    }

    return NextResponse.json(pnl);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
