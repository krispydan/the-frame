export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { buildFaireInstantlyCsv } from "@/modules/sales/lib/faire-marketplace-import";

/**
 * POST /api/admin/sales/faire-instantly-csv
 *
 * Returns an Instantly-ready CSV of the AJM Faire reactivation target cohort
 * (ordered, not a Jaxy customer, within the recency window) that has an email —
 * deduped by inbox. Body = customers CSV (raw) or multipart (customers +
 * emails overlay), same as the analysis route.
 *
 * Columns: email, first_name, last_name, company_name, city, state,
 *          last_ordered, lifetime_spend, tier (high|low).
 *
 *   curl -X POST "$URL/api/admin/sales/faire-instantly-csv?years=4&highMin=1500" \
 *     -H "x-admin-key: jaxy2026" \
 *     -F customers=@fairecustomers.csv -F emails=@emails-found.tsv \
 *     -o faire-instantly.csv
 *
 * Add ?json=true to get counts instead of the raw CSV. Auth: x-admin-key.
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const years = Math.max(1, parseInt(url.searchParams.get("years") || "4", 10));
  const highMin = Math.max(0, parseFloat(url.searchParams.get("highMin") || "1500"));
  const asJson = url.searchParams.get("json") === "true";

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
    return NextResponse.json({ error: "empty body — POST the customers CSV (raw, or -F customers=@file)" }, { status: 400 });
  }

  const { csv, count, targetTotal, withoutEmail, deduped } = buildFaireInstantlyCsv(text, {
    recencyYears: years,
    highMinSpend: highMin,
    emailOverlay,
  });

  if (asJson) {
    return NextResponse.json({ ok: true, count, targetTotal, withoutEmail, deduped });
  }

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="faire-instantly-${new Date().toISOString().slice(0, 10)}.csv"`,
      "X-Lead-Count": String(count),
      "X-Target-Total": String(targetTotal),
      "X-Without-Email": String(withoutEmail),
    },
  });
}
