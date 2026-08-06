export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getReaderTargets, getCategoryBreakdown, type ReaderSegment } from "@/modules/sales/lib/ajm/reader-targets";

/**
 * GET /api/v1/customers/ajm/readers
 *   ?view=targets  (default) reading-glasses buyers ranked by reader spend
 *      segment=all|reader_led|reader_heavy|any_reader
 *      sources=faire,shopify_wholesale  (default; "all" includes retail)
 *      matched=1  noJaxy=1  q=  limit=  format=csv
 *   ?view=categories  category rollups (overall / per source / per year)
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  if (p.get("view") === "categories") {
    return NextResponse.json(getCategoryBreakdown());
  }

  const result = getReaderTargets({
    segment: (p.get("segment") as ReaderSegment | "all") ?? "reader_led",
    sources: (p.get("sources") ?? "faire,shopify_wholesale").split(",").filter(Boolean),
    matchedOnly: p.get("matched") === "1",
    noJaxyOnly: p.get("noJaxy") === "1",
    q: p.get("q") ?? undefined,
    limit: Number(p.get("limit") ?? 200),
  });

  if (p.get("format") === "csv") {
    const head = "Customer,Email,City,State,Reader Revenue,Reader Share %,Sun Revenue,AJM Total,Orders,First Order,Last Order,Jaxy LTV,Top Reader Styles,Channels\n";
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const body = result.targets.map((t) => [
      t.name, t.email, t.city, t.state, t.readerRevenue, t.readerSharePct, t.sunRevenue,
      t.totalRevenue, t.orders, t.firstOrder, t.lastOrder, t.jaxyLtv ?? 0, t.topReaderStyles, t.sources,
    ].map(esc).join(",")).join("\n");
    return new NextResponse(head + body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="ajm-reader-targets-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  return NextResponse.json(result);
}
