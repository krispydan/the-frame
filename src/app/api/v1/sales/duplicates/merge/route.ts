import { NextRequest, NextResponse } from "next/server";
import { mergeCompanies } from "@/modules/sales/lib/dedup";

export async function POST(req: NextRequest) {
  const { primaryId, secondaryId } = await req.json();
  if (!primaryId || !secondaryId) {
    return NextResponse.json({ error: "primaryId and secondaryId required" }, { status: 400 });
  }
  const result = mergeCompanies(primaryId, secondaryId);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
