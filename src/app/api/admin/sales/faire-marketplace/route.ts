export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { analyzeFaireExport, debugFaireStore } from "@/modules/sales/lib/faire-marketplace-import";

/**
 * POST /api/admin/sales/faire-marketplace
 *
 * Dry-run analysis of the AJ Morgan Faire customers export for the
 * pre-Faire-Marketplace calling push. Body = the raw Faire "Customers" export
 * CSV. Keeps only stores that ordered, reports the funnel (ordered → matched to
 * frame → excluded existing Jaxy customers → within recency window) and the
 * value split into Christina (high) / Sandra (low). NO writes.
 *
 * Raw body (customers CSV only):
 *   curl -X POST "$URL/api/admin/sales/faire-marketplace?years=4&highMin=1500" \
 *        -H "x-admin-key: jaxy2026" --data-binary @fairecustomers.csv
 *
 * With the manually looked-up email overlay (fills missing emails):
 *   curl -X POST "$URL/api/admin/sales/faire-marketplace?years=4&highMin=1500" \
 *        -H "x-admin-key: jaxy2026" \
 *        -F customers=@fairecustomers.csv -F emails=@emails-found.tsv
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

  let text = "";
  let emailOverlay: string | undefined;
  if ((req.headers.get("content-type") || "").includes("multipart/form-data")) {
    const form = await req.formData();
    const customers = form.get("customers");
    const emails = form.get("emails");
    if (customers instanceof File) text = await customers.text();
    if (emails instanceof File) emailOverlay = await emails.text();
  } else {
    text = await req.text();
  }
  if (!text || text.trim().length < 20) {
    return NextResponse.json({ error: "empty body — POST the customers CSV (raw body, or -F customers=@file)" }, { status: 400 });
  }

  // ?debug=StoreName → explain why that store is/isn't on the list.
  const debug = url.searchParams.get("debug");
  if (debug) {
    return NextResponse.json({ ok: true, ...debugFaireStore(text, debug, { recencyYears: years, highMinSpend: highMin, emailOverlay }) });
  }

  const analysis = analyzeFaireExport(text, { recencyYears: years, highMinSpend: highMin, emailOverlay });
  return NextResponse.json({ ok: true, dryRun: true, ...analysis });
}
