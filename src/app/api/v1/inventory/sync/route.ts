export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { runStockSync, getSyncStatus } from "@/modules/inventory/lib/stock-sync";

// GET: Get sync status (last sync time + result)
export async function GET() {
  try {
    const status = getSyncStatus();
    return NextResponse.json(status);
  } catch (error: any) {
    console.error("Sync status error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to get sync status" },
      { status: 500 }
    );
  }
}

// POST: Trigger manual inventory sync
export async function POST(request: NextRequest) {
  try {
    const result = await runStockSync();

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || "Sync failed", ...result },
        { status: 500 }
      );
    }

    return NextResponse.json(result);
  } catch (error: any) {
    console.error("Inventory sync error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to sync inventory" },
      { status: 500 }
    );
  }
}
