export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { handleSyncRequest } from "@/modules/sales/lib/instantly-sync";

export async function POST() {
  const result = await handleSyncRequest();
  return NextResponse.json({ data: result });
}
