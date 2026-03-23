export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { settings } from "@/modules/core/schema";
import { orders } from "@/modules/orders/schema";
import { eq, sql } from "drizzle-orm";
import { syncFaireOrders } from "@/modules/orders/lib/faire-sync";

// GET /api/v1/orders/faire-sync — sync status
export async function GET() {
  const lastFaireOrder = db
    .select({
      count: sql<number>`count(*)`,
      latest: sql<string>`max(created_at)`,
    })
    .from(orders)
    .where(eq(orders.channel, "faire"))
    .get();

  const lastSyncSetting = db
    .select()
    .from(settings)
    .where(eq(settings.key, "faire_last_sync"))
    .get();

  return NextResponse.json({
    ok: true,
    totalFaireOrders: lastFaireOrder?.count || 0,
    lastOrderCreated: lastFaireOrder?.latest || null,
    lastSyncAt: lastSyncSetting?.value || null,
  });
}

// POST /api/v1/orders/faire-sync — trigger manual sync
export async function POST(req: NextRequest) {
  try {
    // Check for API token: env var or settings table
    const envToken = process.env.FAIRE_API_TOKEN;
    const settingsToken = db
      .select()
      .from(settings)
      .where(eq(settings.key, "faire_api_token"))
      .get()?.value;

    const token = envToken || settingsToken;
    if (!token) {
      return NextResponse.json(
        { ok: false, error: "Faire API token not configured. Set FAIRE_API_TOKEN env var or add 'faire_api_token' in settings." },
        { status: 400 }
      );
    }

    // Set env for the sync function to use
    if (!envToken && settingsToken) {
      process.env.FAIRE_API_TOKEN = settingsToken;
    }

    const result = await syncFaireOrders();

    // Save last sync time
    db.insert(settings)
      .values({
        key: "faire_last_sync",
        value: new Date().toISOString(),
        type: "string",
        module: "orders",
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: new Date().toISOString() },
      })
      .run();

    const message = `Synced: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped${result.errors.length ? `. ${result.errors.length} errors.` : "."}`;

    return NextResponse.json({
      ok: true,
      message,
      ...result,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: String(err) },
      { status: 500 }
    );
  }
}
