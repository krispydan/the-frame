export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import { sqlite } from "@/lib/db";
import { importBigSkyInvoice } from "@/modules/operations/lib/three-pl/import-invoice";

/**
 * Token-guarded 3PL invoice ops (x-ops-key: OPS_TOKEN).
 * GET             → list imported invoices + audit flag counts
 * POST ?confirm=1 → upload a Big Sky xlsx (multipart field "file") and import.
 *   curl -F "file=@invoice.xlsx" -H "x-ops-key: $OPS_TOKEN" ".../ops/three-pl?confirm=1"
 */
export async function GET(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;
  const invoices = sqlite.prepare(
    `SELECT id, period_start AS periodStart, period_end AS periodEnd, filename,
            total_amount AS totalAmount, detail_orders AS detailOrders,
            matched_orders AS matchedOrders, unmatched_orders AS unmatchedOrders,
            audit_flags AS auditFlags, imported_at AS importedAt
     FROM three_pl_invoices ORDER BY period_start DESC`,
  ).all();
  return NextResponse.json({ invoices });
}

export async function POST(req: NextRequest) {
  const denied = requireOpsToken(req, { mutation: true });
  if (denied) return denied;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data with 'file'" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Missing 'file' upload" }, { status: 400 });
  try {
    const result = await importBigSkyInvoice(Buffer.from(await file.arrayBuffer()), file.name);
    return NextResponse.json(result);
  } catch (e) {
    console.error("[ops/three-pl] import failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
