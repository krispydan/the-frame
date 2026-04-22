export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { operationsExports, purchaseOrders, purchaseOrderItems } from "@/modules/catalog/schema";
import { eq } from "drizzle-orm";
import { buildPurchaseOrderCsv } from "@/modules/operations/lib/shiphero/purchase-order";
import { autogeneratePoNumber, detectVendor } from "@/modules/operations/lib/shiphero/sku-parsing";

/**
 * POST /api/v1/operations/exports/shiphero/po
 *
 * Accepts either an existing PO id or a pasted shipment list.
 *
 * Body (mutually exclusive):
 *   { purchaseOrderId: string }   — use line items stored on the PO
 *   { poNumber?, vendor?, freightType?, defaultUnitPrice?, lineItems: [{sku, quantity, unitPrice?, vendorSku?}] }
 *
 * The second form creates a new PO record (with its line items) so we can
 * re-export later and keep an audit trail.
 *
 * Query:
 *   ?preview=true   — JSON preview (row count, warnings, sample)
 */
export async function POST(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const preview = searchParams.get("preview") === "true";

  const body = await request.json().catch(() => ({}));
  let poNumber: string | undefined = body.poNumber;
  let vendor: string | undefined = body.vendor;
  let shipDate: string | undefined = body.shipDate;
  let poDate: string | undefined = body.poDate;
  let freightType: "air" | "ocean" = body.freightType === "ocean" ? "ocean" : "air";
  let defaultUnitPrice: number | null = body.defaultUnitPrice ?? null;
  let lineItems: { sku: string; quantity: number; unitPrice?: number | null; vendorSku?: string | null }[] = [];

  // Path 1: load from existing PO
  if (body.purchaseOrderId) {
    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, body.purchaseOrderId));
    if (!po) return NextResponse.json({ error: "Purchase order not found" }, { status: 404 });
    const items = await db.select().from(purchaseOrderItems).where(eq(purchaseOrderItems.purchaseOrderId, po.id));

    poNumber = poNumber ?? po.poNumber ?? undefined;
    vendor = vendor ?? po.factoryCode ?? undefined;
    shipDate = shipDate ?? po.shipDate ?? undefined;
    poDate = poDate ?? po.orderDate ?? undefined;
    if (po.freightType === "ocean") freightType = "ocean";
    lineItems = items.map((it) => ({
      sku: it.sku,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      vendorSku: it.vendorSku,
    }));
  }
  // Path 2: pasted list
  else if (Array.isArray(body.lineItems)) {
    lineItems = body.lineItems.map((li: { sku?: string; quantity?: number | string; unitPrice?: number | string | null; vendorSku?: string | null }) => ({
      sku: String(li.sku ?? "").trim().toUpperCase(),
      quantity: Number(li.quantity ?? 0),
      unitPrice: li.unitPrice == null || li.unitPrice === "" ? null : Number(li.unitPrice),
      vendorSku: li.vendorSku ?? null,
    }));
  } else {
    return NextResponse.json({ error: "Provide either purchaseOrderId or lineItems" }, { status: 400 });
  }

  if (lineItems.length === 0) {
    return NextResponse.json({ error: "No line items" }, { status: 400 });
  }

  // Detect vendor if still missing
  if (!vendor) {
    try {
      const detected = detectVendor(lineItems.map((li) => li.sku));
      vendor = detected.vendor;
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Vendor detection failed" }, { status: 400 });
    }
  }

  // PO number: autogenerate if missing
  if (!poNumber) {
    const existingRows = sqlite.prepare("SELECT po_number FROM catalog_purchase_orders WHERE po_number IS NOT NULL").all() as { po_number: string }[];
    const existing = new Set<string>(existingRows.map((r) => r.po_number));
    poNumber = autogeneratePoNumber(vendor, existing);
  }

  let result;
  try {
    result = buildPurchaseOrderCsv({
      poNumber,
      vendor,
      shipDate,
      poDate,
      freightType,
      defaultUnitPrice,
      lineItems,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "CSV build failed" }, { status: 400 });
  }

  if (preview) {
    return NextResponse.json({
      poNumber,
      vendor: result.vendor,
      rowCount: result.warnings.emitted,
      warnings: result.warnings,
      sample: lineItems.slice(0, 10),
    });
  }

  // Path 2: persist PO + line items so future re-exports work
  if (!body.purchaseOrderId) {
    try {
      const poId = crypto.randomUUID();
      await db.insert(purchaseOrders).values({
        id: poId,
        poNumber,
        supplier: result.vendor,
        factoryCode: result.vendor,
        orderDate: poDate ?? new Date().toISOString().slice(0, 10),
        shipDate: shipDate ?? new Date().toISOString().slice(0, 10),
        freightType,
        shippingMethod: freightType === "air" ? "DHL" : "",
        status: "ordered",
      });
      for (const li of lineItems) {
        if (li.quantity <= 0) continue;
        await db.insert(purchaseOrderItems).values({
          purchaseOrderId: poId,
          sku: li.sku,
          vendorSku: li.vendorSku ?? null,
          quantity: li.quantity,
          unitPrice: li.unitPrice == null ? defaultUnitPrice : li.unitPrice,
        });
      }
    } catch (e) {
      console.error("[shiphero/po] PO persistence error:", e);
      // Don't fail the export — the CSV is still valid.
    }
  }

  const filename = `shiphero_po_${poNumber}.csv`;

  try {
    await db.insert(operationsExports).values({
      exportType: "shiphero_po",
      filename,
      rowCount: result.warnings.emitted,
      filters: JSON.stringify({ poNumber, vendor: result.vendor, freightType }),
      createdBy: "admin",
    });
  } catch (e) {
    console.error("[shiphero/po] Audit log error:", e);
  }

  return new NextResponse(result.csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Export-Row-Count": String(result.warnings.emitted),
      "X-PO-Number": poNumber,
      "X-Vendor": result.vendor,
    },
  });
}
