export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { shopifyWebhookEvents } from "@/modules/integrations/schema/shopify";
import { webhookRegistry } from "@/modules/core/lib/webhooks";
import { getAppConfig, verifyWebhookHmac } from "@/modules/integrations/lib/shopify/oauth";

// Ensure the shopify handler is registered
import "@/modules/orders/lib/shopify-webhooks";

/**
 * POST /api/v1/webhooks/shopify
 *
 * Single entry point for every Shopify webhook subscription configured in
 * shopify.app.toml (orders/*, fulfillments/*, inventory_levels/update,
 * customers/*, products/*, etc.).
 *
 * Always logs the event to shopify_webhook_events for observability before
 * dispatching to the registered handler. That way the integrations page can
 * show what's actually firing from Shopify even when a handler errors out.
 */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });

  const topic = headers["x-shopify-topic"] || null;
  const shopDomain = headers["x-shopify-shop-domain"] || null;
  const webhookId = headers["x-shopify-webhook-id"] || null;
  const triggeredAt = headers["x-shopify-triggered-at"] || null;

  // HMAC verification using the public-app shared secret.
  let hmacValid = false;
  try {
    const config = getAppConfig();
    hmacValid = verifyWebhookHmac(body, headers["x-shopify-hmac-sha256"], config.apiSecret);
  } catch {
    hmacValid = false;
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    await logEvent({
      shopDomain, topic, webhookId, triggeredAt, hmacValid,
      handlerOk: false, handlerMessage: "Invalid JSON",
      payloadSize: body.length, payloadPreview: body.slice(0, 500),
    });
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Reject if HMAC failed — never dispatch unverified data to handlers.
  if (!hmacValid) {
    await logEvent({
      shopDomain, topic, webhookId, triggeredAt, hmacValid: false,
      handlerOk: false, handlerMessage: "HMAC verification failed",
      payloadSize: body.length, payloadPreview: body.slice(0, 500),
    });
    return NextResponse.json({ error: "Invalid HMAC" }, { status: 401 });
  }

  const handler = webhookRegistry.getHandler("shopify");
  if (!handler) {
    await logEvent({
      shopDomain, topic, webhookId, triggeredAt, hmacValid: true,
      handlerOk: false, handlerMessage: "Shopify handler not registered",
      payloadSize: body.length, payloadPreview: body.slice(0, 500),
    });
    return NextResponse.json({ error: "Shopify handler not registered" }, { status: 500 });
  }

  let handlerOk = true;
  let handlerMessage: string | null = null;

  try {
    const result = await handler({
      provider: "shopify",
      headers,
      body,
      parsedBody,
    });
    handlerOk = !!result.ok;
    handlerMessage = result.message ?? null;
  } catch (err) {
    handlerOk = false;
    handlerMessage = err instanceof Error ? err.message : String(err);
    console.error("[Shopify Webhook] Handler threw:", err);
  }

  await logEvent({
    shopDomain, topic, webhookId, triggeredAt, hmacValid: true,
    handlerOk, handlerMessage,
    payloadSize: body.length, payloadPreview: body.slice(0, 500),
  });

  if (!handlerOk) {
    return NextResponse.json({ ok: false, error: handlerMessage || "Handler returned error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

type LogPayload = {
  shopDomain: string | null;
  topic: string | null;
  webhookId: string | null;
  triggeredAt: string | null;
  hmacValid: boolean;
  handlerOk: boolean;
  handlerMessage: string | null;
  payloadSize: number;
  payloadPreview: string;
};

async function logEvent(p: LogPayload) {
  try {
    await db.insert(shopifyWebhookEvents).values({
      shopDomain: p.shopDomain,
      topic: p.topic,
      webhookId: p.webhookId,
      triggeredAt: p.triggeredAt,
      hmacValid: p.hmacValid,
      handlerOk: p.handlerOk,
      handlerMessage: p.handlerMessage,
      payloadSize: p.payloadSize,
      payloadPreview: p.payloadPreview,
    });
  } catch (err) {
    console.error("[Shopify Webhook] Failed to log event:", err);
  }
}
