export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { settlements, settlementLineItems } from "@/modules/finance/schema";
import { eq } from "drizzle-orm";
import { syncSettlementToXero } from "@/modules/finance/lib/xero-client";

// GET /api/v1/finance/settlements/:id
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const settlement = db.select().from(settlements).where(eq(settlements.id, id)).get();
  if (!settlement) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const lineItems = db.select().from(settlementLineItems).where(eq(settlementLineItems.settlementId, id)).all();
  return NextResponse.json({ ...settlement, lineItems });
}

// PATCH /api/v1/finance/settlements/:id — update status or sync to Xero
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();

  if (body.action === "sync_to_xero") {
    const result = await syncSettlementToXero(id);
    return NextResponse.json(result);
  }

  if (body.status) {
    db.update(settlements).set({ status: body.status }).where(eq(settlements.id, id)).run();
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "No action specified" }, { status: 400 });
}
