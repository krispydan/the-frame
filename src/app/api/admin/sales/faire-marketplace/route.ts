export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { analyzeFaireExport } from "@/modules/sales/lib/faire-marketplace-import";

/**
 * POST /api/admin/sales/faire-marketplace
 *
 * Dry-run analysis of the AJ Morgan Faire customers export for the
 * pre-Faire-Marketplace calling push. Body = the raw Faire "Customers" export
 * CSV. Keeps only stores that ordered, reports the funnel (ordered → matched to
 * frame → excluded existing Jaxy customers → within recency window) and the
 * value split into Christina (high) / Sandra (low). NO writes.
 *
 *   curl -X POST "$URL/api/admin/sales/faire-marketplace?years=4&highMin=1500" \
 *        -H "x-admin-key: jaxy2026" --data-binary @fairecustomers.csv
 *
 * Auth: x-admin-key: jaxy2026
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const years = Math.max(1, parseInt(url.searchParams.get("years") || "4", 10));
  const highMin = Math.max(0, parseFloat(url.searchParams.get("highMin") || "1500"));

  const text = await req.text();
  if (!text || text.trim().length < 20) {
    return NextResponse.json({ error: "empty body — POST the export TSV as the request body" }, { status: 400 });
  }

  const analysis = analyzeFaireExport(text, { recencyYears: years, highMinSpend: highMin });
  return NextResponse.json({ ok: true, dryRun: true, ...analysis });
}
