export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { auditInvoice } from "@/modules/operations/lib/three-pl/audit";

/**
 * GET    /api/v1/operations/three-pl/invoices/[id] → full detail + audit
 * POST   ?reaudit=1 → re-run the audit (e.g. after a rate-card edit)
 * DELETE → remove the invoice + its charges/storage rows
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invoice = sqlite.prepare(
    `SELECT id, period_start AS periodStart, period_end AS periodEnd, filename,
            total_amount AS totalAmount, detail_orders AS detailOrders,
            matched_orders AS matchedOrders, unmatched_orders AS unmatchedOrders,
            imported_at AS importedAt, summary_json AS summaryJson, audit_json AS auditJson
     FROM three_pl_invoices WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

  const unmatched = sqlite.prepare(
    `SELECT DISTINCT order_number_raw AS orderNumber, charge_type AS chargeType, amount
     FROM three_pl_charges WHERE invoice_id = ? AND match_status = 'unmatched'
     ORDER BY amount DESC LIMIT 50`,
  ).all(id);

  const storage = sqlite.prepare(
    `SELECT storage_type AS storageType, COUNT(*) AS days, ROUND(SUM(amount),2) AS amount,
            ROUND(AVG(quantity),1) AS avgLocations
     FROM three_pl_storage_days WHERE invoice_id = ? GROUP BY storage_type`,
  ).all(id);

  return NextResponse.json({
    ...invoice,
    summary: JSON.parse((invoice.summaryJson as string) || "[]"),
    audit: JSON.parse((invoice.auditJson as string) || "null"),
    summaryJson: undefined,
    auditJson: undefined,
    unmatched,
    storage,
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (req.nextUrl.searchParams.get("reaudit") !== "1") {
    return NextResponse.json({ error: "pass ?reaudit=1" }, { status: 400 });
  }
  const audit = auditInvoice(id);
  sqlite.prepare("UPDATE three_pl_invoices SET audit_json = ?, audit_flags = ? WHERE id = ?")
    .run(JSON.stringify(audit), audit.findings.length, id);
  return NextResponse.json(audit);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  sqlite.prepare("DELETE FROM three_pl_charges WHERE invoice_id = ?").run(id);
  sqlite.prepare("DELETE FROM three_pl_storage_days WHERE invoice_id = ?").run(id);
  const r = sqlite.prepare("DELETE FROM three_pl_invoices WHERE id = ?").run(id);
  return NextResponse.json({ deleted: r.changes > 0 });
}
