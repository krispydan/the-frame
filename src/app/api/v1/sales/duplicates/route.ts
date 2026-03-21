import { NextRequest, NextResponse } from "next/server";
import { findDuplicates } from "@/modules/sales/lib/dedup";

export async function GET(req: NextRequest) {
  const limit = parseInt(req.nextUrl.searchParams.get("limit") || "50");
  const duplicates = findDuplicates(limit);
  return NextResponse.json({ data: duplicates, total: duplicates.length });
}
