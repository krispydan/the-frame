export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const inspections = db.all(sql`
      SELECT * FROM inventory_qc_inspections
      WHERE po_id = ${id}
      ORDER BY created_at DESC
    `);
    return NextResponse.json({ inspections });
  } catch (error) {
    return NextResponse.json({ error: "Failed to fetch QC inspections" }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await request.json();
    const { inspector, totalUnits, defectCount, notes } = body;

    const defectRate = totalUnits > 0 ? Math.round((defectCount / totalUnits) * 10000) / 100 : 0;
    const status = defectRate > 5 ? "failed" : defectRate > 2 ? "pending" : "passed";

    const qcId = crypto.randomUUID();
    db.run(sql`
      INSERT INTO inventory_qc_inspections (id, po_id, inspector, inspection_date, total_units, defect_count, defect_rate, status, notes)
      VALUES (${qcId}, ${id}, ${inspector || "QC Team"}, ${new Date().toISOString().split("T")[0]}, ${totalUnits}, ${defectCount}, ${defectRate}, ${status}, ${notes || null})
    `);

    return NextResponse.json({ id: qcId, defectRate, status }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: "Failed to create QC inspection" }, { status: 500 });
  }
}
