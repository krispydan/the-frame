export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-middleware";
import { sqlite } from "@/lib/db";
import { isConfigured } from "@/modules/operations/lib/shiphero/api-client";

/**
 * GET /api/v1/integrations/shiphero
 *
 * Returns ShipHero integration status: configured, last sync times,
 * SKU/order counts, and recent job history.
 */
export const GET = apiHandler(
  async () => {
    const configured = isConfigured();

    // Last inventory sync
    const invSync = sqlite.prepare(
      "SELECT MAX(synced_at) as last_synced_at, COUNT(*) as sku_count FROM shiphero_inventory"
    ).get() as { last_synced_at: string | null; sku_count: number };

    // SKUs with stock
    const withStock = sqlite.prepare(
      "SELECT COUNT(*) as c FROM shiphero_inventory WHERE on_hand > 0"
    ).get() as { c: number };

    // Last order sync
    const orderSync = sqlite.prepare(
      "SELECT MAX(synced_at) as last_synced_at, COUNT(*) as shipment_count FROM shiphero_shipments"
    ).get() as { last_synced_at: string | null; shipment_count: number };

    const matchedOrders = sqlite.prepare(
      "SELECT COUNT(*) as c FROM orders WHERE shiphero_order_id IS NOT NULL"
    ).get() as { c: number };

    // Recent job runs
    const recentJobs = sqlite.prepare(`
      SELECT type, status, error, started_at, completed_at, output
      FROM jobs
      WHERE type LIKE 'shiphero.%'
      ORDER BY COALESCE(completed_at, started_at, created_at) DESC
      LIMIT 6
    `).all() as Array<{
      type: string;
      status: string;
      error: string | null;
      started_at: string | null;
      completed_at: string | null;
      output: string | null;
    }>;

    // Determine health: last completed job within last 2 hours and no errors
    const lastCompleted = recentJobs.find((j) => j.status === "completed");
    const lastFailed = recentJobs.find((j) => j.status === "failed");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    let health: "ok" | "warn" | "off" = "off";
    if (!configured) {
      health = "off";
    } else if (lastFailed && (!lastCompleted || lastFailed.completed_at! > lastCompleted.completed_at!)) {
      health = "warn";
    } else if (lastCompleted && lastCompleted.completed_at! > twoHoursAgo) {
      health = "ok";
    } else if (lastCompleted) {
      health = "warn"; // last sync was more than 2 hours ago
    }

    return NextResponse.json({
      configured,
      health,
      inventory: {
        lastSyncedAt: invSync.last_synced_at,
        skuCount: invSync.sku_count,
        skusWithStock: withStock.c,
      },
      orders: {
        lastSyncedAt: orderSync.last_synced_at,
        matchedOrders: matchedOrders.c,
        shipmentCount: orderSync.shipment_count,
      },
      recentJobs: recentJobs.map((j) => ({
        type: j.type.replace("shiphero.", ""),
        status: j.status,
        error: j.error,
        startedAt: j.started_at,
        completedAt: j.completed_at,
      })),
    });
  },
  { auth: true, roles: ["owner", "warehouse", "finance"] },
);
