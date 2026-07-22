export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import {
  listIntlShippingRequests,
  updateIntlShippingRequest,
  sendDimsEmailForRequest,
  maybeCreateInternationalShippingRequest,
  isIntlShippingEnabled,
  isIntlShippingAutoSend,
} from "@/modules/orders/lib/international-shipping";

function getSetting(key: string): string | null {
  const r = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string | null } | undefined;
  return r?.value ?? null;
}
function setSetting(key: string, value: string): void {
  sqlite.prepare(
    `INSERT INTO settings (key, value, type, module, updated_at)
     VALUES (?, ?, 'string', 'orders', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, value);
}

/**
 * GET /api/v1/orders/international-shipping
 *   ?status=awaiting_dims|awaiting_label|... (default: all)
 * Returns the request queue plus the current feature-flag settings.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const status = searchParams.get("status") || "all";
  const requests = listIntlShippingRequests(status);
  return NextResponse.json({
    requests,
    settings: {
      enabled: isIntlShippingEnabled(),
      autoSend: isIntlShippingAutoSend(),
      warehouseEmail: getSetting("intl_shipping_warehouse_email") || "team@bigskyfulfillment.com",
      ccEmail: getSetting("intl_shipping_cc_email") || "wholesale@getjaxy.com",
    },
  });
}

/**
 * POST /api/v1/orders/international-shipping — multi-action endpoint
 *
 * Body actions:
 *   { action: "send-email", id }             → send/re-send the dims email
 *   { action: "save-dims", id, length, width, height, weight, boxCount }
 *   { action: "set-status", id, status }
 *   { action: "update-shiphero", id, shipheroOrderId }
 *   { action: "set-flag", key: "enabled"|"autoSend", value: boolean }
 *   { action: "set-email", warehouseEmail?, ccEmail? }
 *   { action: "recheck-order", orderId }     → manually run detection on an order
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { action } = body;

  if (action === "send-email") {
    if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const result = await sendDimsEmailForRequest(body.id);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (action === "save-dims") {
    if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    updateIntlShippingRequest(body.id, {
      packaged_length_in: body.length ?? null,
      packaged_width_in: body.width ?? null,
      packaged_height_in: body.height ?? null,
      packaged_weight_lb: body.weight ?? null,
      box_count: body.boxCount ?? 1,
      dims_received_at: new Date().toISOString(),
      // Once we have dims, we're ready to make the label
      status: "awaiting_label",
    });
    return NextResponse.json({ ok: true });
  }

  if (action === "set-status") {
    if (!body.id || !body.status) {
      return NextResponse.json({ error: "id and status required" }, { status: 400 });
    }
    updateIntlShippingRequest(body.id, { status: body.status });
    return NextResponse.json({ ok: true });
  }

  if (action === "update-shiphero") {
    if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    updateIntlShippingRequest(body.id, { shiphero_order_id: body.shipheroOrderId ?? null });
    return NextResponse.json({ ok: true });
  }

  if (action === "set-flag") {
    const { key, value } = body;
    if (key === "enabled") {
      setSetting("intl_shipping_enabled", value ? "true" : "false");
      return NextResponse.json({ ok: true, enabled: !!value });
    }
    if (key === "autoSend") {
      setSetting("intl_shipping_auto_send", value ? "true" : "false");
      return NextResponse.json({ ok: true, autoSend: !!value });
    }
    return NextResponse.json({ error: "unknown flag" }, { status: 400 });
  }

  if (action === "set-email") {
    if (body.warehouseEmail) setSetting("intl_shipping_warehouse_email", body.warehouseEmail);
    if (body.ccEmail) setSetting("intl_shipping_cc_email", body.ccEmail);
    return NextResponse.json({ ok: true });
  }

  if (action === "recheck-order") {
    if (!body.orderId) return NextResponse.json({ error: "orderId required" }, { status: 400 });
    const row = await maybeCreateInternationalShippingRequest(body.orderId);
    return NextResponse.json({ ok: true, created: !!row, request: row });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
