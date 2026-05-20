export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { getShopifyClientByChannel } from "@/modules/integrations/lib/shopify/admin-api";

/**
 * POST /api/v1/orders/backfill-ship-to-name
 *
 * Re-derives orders.ship_to_name for legacy orders created before the
 * column existed. Pulls each Shopify order from its source shop's
 * Admin REST API, picks (shipping_address.company || shipping_address.name
 * || customer.first_name+last_name), and writes it.
 *
 * Body (all optional):
 *   { "limit": 50, "dryRun": false }
 *
 * Re-runs are safe — only orders with NULL ship_to_name are touched.
 * Cap per call is small so each invocation stays under Cloudflare's
 * ~100s edge timeout. Re-run until processed === 0.
 */
export async function POST(req: NextRequest) {
  let body: { limit?: number; dryRun?: boolean } = {};
  try {
    body = (await req.json()) as { limit?: number; dryRun?: boolean };
  } catch {
    // empty body fine
  }
  const limit = Math.min(Math.max(body.limit ?? 25, 1), 100);
  const dryRun = !!body.dryRun;

  const candidates = sqlite
    .prepare(
      `SELECT id, order_number, external_id, channel
       FROM orders
       WHERE ship_to_name IS NULL
         AND external_id IS NOT NULL
         AND channel IN ('shopify_dtc', 'shopify_wholesale')
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
      id: string;
      order_number: string;
      external_id: string;
      channel: string;
    }>;

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      candidates: candidates.length,
      preview: candidates.slice(0, 20),
    });
  }

  const update = sqlite.prepare(
    `UPDATE orders SET ship_to_name = ?, updated_at = datetime('now') WHERE id = ?`,
  );

  // Cache shop clients to avoid re-loading per row.
  const clients: Record<string, Awaited<ReturnType<typeof getShopifyClientByChannel>> | null> = {};
  async function client(channel: string) {
    if (clients[channel] !== undefined) return clients[channel];
    try {
      const shopChannel = channel === "shopify_wholesale" ? "wholesale" : "retail";
      clients[channel] = await getShopifyClientByChannel(shopChannel);
    } catch (e) {
      console.error(`[backfill-ship-to-name] client load failed for ${channel}:`, e);
      clients[channel] = null;
    }
    return clients[channel];
  }

  interface ShopifyAddress {
    name?: string;
    first_name?: string;
    last_name?: string;
    company?: string;
  }
  interface ShopifyOrderShape {
    order?: {
      shipping_address?: ShopifyAddress;
      customer?: { first_name?: string; last_name?: string };
    };
  }

  function pick(o: ShopifyOrderShape["order"]): string | null {
    const sa = o?.shipping_address;
    const company = sa?.company?.trim();
    if (company) return company;
    const saName =
      sa?.name?.trim() ||
      [sa?.first_name, sa?.last_name].filter(Boolean).join(" ").trim();
    if (saName) return saName;
    const cust =
      [o?.customer?.first_name, o?.customer?.last_name]
        .filter(Boolean)
        .join(" ")
        .trim();
    return cust || null;
  }

  const results: Array<{ orderNumber: string; status: "updated" | "noop" | "error"; shipTo?: string | null; error?: string }> = [];
  for (const c of candidates) {
    try {
      const cl = await client(c.channel);
      if (!cl) {
        results.push({ orderNumber: c.order_number, status: "error", error: "Shop client unavailable" });
        continue;
      }
      const data = (await cl.rest("GET", `/orders/${c.external_id}.json`)) as ShopifyOrderShape;
      const shipTo = pick(data.order);
      if (!shipTo) {
        results.push({ orderNumber: c.order_number, status: "noop", shipTo: null });
        continue;
      }
      update.run(shipTo, c.id);
      results.push({ orderNumber: c.order_number, status: "updated", shipTo });
    } catch (e) {
      results.push({
        orderNumber: c.order_number,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
    // Light pacing — Shopify REST allows ~2/s per shop on standard plans.
    await new Promise((r) => setTimeout(r, 350));
  }

  return NextResponse.json({
    ok: true,
    candidates: candidates.length,
    processed: results.length,
    results,
  });
}
