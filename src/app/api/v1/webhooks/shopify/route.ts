export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { webhookRegistry } from "@/modules/core/lib/webhooks";

// Ensure the shopify handler is registered
import "@/modules/orders/lib/shopify-webhooks";

// POST /api/v1/webhooks/shopify — receive Shopify webhooks
export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const handler = webhookRegistry.getHandler("shopify");
    if (!handler) {
      return NextResponse.json({ error: "Shopify handler not registered" }, { status: 500 });
    }

    const result = await handler({
      provider: "shopify",
      headers,
      body,
      parsedBody,
    });

    if (!result.ok) {
      console.error("[Shopify Webhook] Handler error:", result.message);
      return NextResponse.json({ error: result.message }, { status: 401 });
    }

    return NextResponse.json({ ok: true, message: result.message });
  } catch (err) {
    console.error("[Shopify Webhook] Unhandled error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
