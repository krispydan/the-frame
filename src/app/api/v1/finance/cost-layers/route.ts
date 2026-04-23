export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import {
  getCostLayerSummary,
  getCostLayersForSku,
  createCostLayer,
  createCostLayersFromPO,
} from "@/modules/finance/lib/fifo-engine";

/**
 * GET /api/v1/finance/cost-layers — list cost layers
 *   ?summary=true → grouped by SKU with totals
 *   ?skuId=xxx → detailed layers for a specific SKU
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const summary = searchParams.get("summary") === "true";
  const skuId = searchParams.get("skuId");

  if (summary) {
    return NextResponse.json(getCostLayerSummary());
  }

  if (skuId) {
    return NextResponse.json(getCostLayersForSku(skuId));
  }

  return NextResponse.json(getCostLayerSummary());
}

/**
 * POST /api/v1/finance/cost-layers — create cost layers
 *   { fromPO: "poId" } → create layers from all line items on a PO
 *   { manual: { skuId, quantity, unitCost, ... } } → create a single manual layer
 */
export async function POST(request: NextRequest) {
  const body = await request.json();

  if (body.fromPO) {
    try {
      const layers = createCostLayersFromPO(body.fromPO);
      return NextResponse.json({
        created: layers.length,
        layers: layers.map((l) => ({
          id: l.id,
          skuId: l.skuId,
          quantity: l.quantity,
          landedCostPerUnit: l.landedCostPerUnit,
        })),
      });
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 400 });
    }
  }

  if (body.manual) {
    const { skuId, quantity, unitCost, freightPerUnit, dutiesPerUnit, shippingMethod, receivedAt, poNumber } = body.manual;
    if (!skuId || !quantity || unitCost === undefined) {
      return NextResponse.json({ error: "skuId, quantity, and unitCost required" }, { status: 400 });
    }
    const layer = createCostLayer({
      skuId, quantity, unitCost,
      freightPerUnit, dutiesPerUnit,
      shippingMethod, receivedAt, poNumber,
    });
    return NextResponse.json({ layer });
  }

  return NextResponse.json({ error: "Provide { fromPO } or { manual }" }, { status: 400 });
}
