export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { buildFaireCampaignPlan } from "@/modules/sales/lib/faire-marketplace-import";

/**
 * POST /api/admin/sales/faire-campaign-plan
 *
 * One reviewable spreadsheet of the whole Faire Market campaign: every target
 * store with its channel (Instantly email / PhoneBurner call / needs
 * enrichment), owner (Christina high / Sandra low), value, and contact info.
 * Body = customers CSV (raw) or multipart (customers + emails overlay).
 *
 *   curl -X POST "$URL/api/admin/sales/faire-campaign-plan?years=4&highMin=1500" \
 *     -H "x-admin-key: jaxy2026" \
 *     -F customers=@fairecustomers.csv -F emails=@emails-found.tsv \
 *     -o faire-campaign-plan.csv
 *
 * Add ?json=true for the summary counts instead of the CSV. Auth: x-admin-key.
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

  const { csv, count, summary } = buildFaireCampaignPlan(text, { recencyYears: years, highMinSpend: highMin, emailOverlay });

  if (asJson) return NextResponse.json({ ok: true, count, summary });

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="faire-campaign-plan-${new Date().toISOString().slice(0, 10)}.csv"`,
      "X-Total": String(count),
      "X-Instantly": String(summary.instantly_email),
      "X-PhoneBurner": String(summary.phoneburner_call),
      "X-Needs-Enrichment": String(summary.needs_enrichment),
    },
  });
}
