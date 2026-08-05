export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { importBigSkyInvoice } from "@/modules/operations/lib/three-pl/import-invoice";

/**
 * GET  /api/v1/operations/three-pl/invoices → invoice list + category totals
 * POST /api/v1/operations/three-pl/invoices → upload a Big Sky monthly xlsx
 *   (multipart form, field "file"). Re-uploading the same period replaces it.
 */
export async function GET() {
  const invoices = sqlite.prepare(
    `SELECT id, period_start AS periodStart, period_end AS periodEnd, filename,
            total_amount AS totalAmount, detail_orders AS detailOrders,
            matched_orders AS matchedOrders, unmatched_orders AS unmatchedOrders,
            audit_flags AS auditFlags, imported_at AS importedAt, summary_json AS summaryJson
     FROM three_pl_invoices ORDER BY period_start DESC`,
  ).all() as Array<Record<string, unknown>>;

  // Monthly totals by charge category (for the trend view)
  const byMonth = sqlite.prepare(
    `SELECT i.period_start AS period, c.charge_type AS chargeType,
            ROUND(SUM(c.amount), 2) AS amount
     FROM three_pl_charges c JOIN three_pl_invoices i ON i.id = c.invoice_id
     GROUP BY i.period_start, c.charge_type`,
  ).all();
  const storageByMonth = sqlite.prepare(
    `SELECT i.period_start AS period, 'storage' AS chargeType, ROUND(SUM(s.amount), 2) AS amount
     FROM three_pl_storage_days s JOIN three_pl_invoices i ON i.id = s.invoice_id
     GROUP BY i.period_start`,
  ).all();

  return NextResponse.json({
    invoices: invoices.map((r) => ({ ...r, summary: JSON.parse((r.summaryJson as string) || "[]"), summaryJson: undefined })),
    categoriesByMonth: [...(byMonth as []), ...(storageByMonth as [])],
  });
}

export async function POST(request: NextRequest) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data with a 'file' field" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' upload" }, { status: 400 });
  }
  if (!/\.(xlsx|xls)$/i.test(file.name)) {
    return NextResponse.json({ error: "Expected an .xlsx invoice export" }, { status: 400 });
  }
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const result = await importBigSkyInvoice(buf, file.name);
    return NextResponse.json(result);
  } catch (e) {
    console.error("[three-pl] import failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
