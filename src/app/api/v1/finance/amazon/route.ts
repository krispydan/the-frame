export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import {
  getAmazonHeadline,
  getAmazonDaily,
  getAmazonSkus,
  getAmazonSettlements,
  getAmazonInventory,
  getAmazonSyncHealth,
  getAmazonUnmappedSkus,
} from "@/modules/integrations/lib/amazon/metrics";

/**
 * GET /api/v1/finance/amazon?range=30d|90d|mtd|custom&from=&to=
 *
 * Everything the Amazon dashboard needs in one round trip. Reads local
 * tables only, so the page renders fast and keeps working when Windsor is
 * down — including for history that has aged out of Amazon's 90-day window.
 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const range = sp.get("range") ?? "30d";
    const today = new Date().toISOString().slice(0, 10);

    const daysAgo = (n: number) =>
      new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

    let from: string;
    let to = today;

    switch (range) {
      case "7d": from = daysAgo(6); break;
      case "90d": from = daysAgo(89); break;
      case "mtd": from = `${today.slice(0, 7)}-01`; break;
      case "all": from = "2020-01-01"; break;
      case "custom": {
        const f = sp.get("from");
        const t = sp.get("to");
        const isDate = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
        if (!isDate(f) || !isDate(t)) {
          return NextResponse.json({ ok: false, error: "custom range requires from and to as YYYY-MM-DD" }, { status: 400 });
        }
        if (f > t) {
          return NextResponse.json({ ok: false, error: "`from` is after `to`" }, { status: 400 });
        }
        from = f; to = t;
        break;
      }
      default: from = daysAgo(29);
    }

    return NextResponse.json({
      ok: true,
      range: { from, to, preset: range },
      configured: Boolean(process.env.WINDSOR_API_KEY),
      headline: getAmazonHeadline({ from, to }),
      daily: getAmazonDaily({ from, to }),
      skus: getAmazonSkus({ from, to }),
      settlements: getAmazonSettlements(),
      inventory: getAmazonInventory(),
      syncHealth: getAmazonSyncHealth(),
      unmappedSkus: getAmazonUnmappedSkus(),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
