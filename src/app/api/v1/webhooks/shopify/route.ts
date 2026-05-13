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
  void detectFlood();
}

// Rolling-window flood detector. Counts events in the last 60 seconds and
// fires a single Slack alert when something looks WRONG — high volume alone
// is not enough. Cooldown prevents repeat alerts during a sustained burst.
//
// Trigger Slack only when the window has:
//   - any HMAC failures (security / misconfig signal), OR
//   - any handler failures, OR
//   - >= ABSURD_THRESHOLD events (rate-limit-territory volume, even if all OK)
//
// Healthy backlog drains (e.g., Shopify replaying a queue after we fix a
// delivery URL) trip the count but post nothing — no action is needed and
// the noise was actively unhelpful per Daniel's feedback on the last one.
let lastFloodAlertAt = 0;
const FLOOD_THRESHOLD = 100;        // events per window (informational only)
const ABSURD_THRESHOLD = 1000;      // events per window — escalate even if all OK
const FLOOD_WINDOW_SECONDS = 60;
const FLOOD_COOLDOWN_MS = 10 * 60_000;  // 10 minutes between alerts

async function detectFlood(): Promise<void> {
  if (Date.now() - lastFloodAlertAt < FLOOD_COOLDOWN_MS) return;
  try {
    const { sqlite: rawDb } = await import("@/lib/db");
    const sinceClause = `-${FLOOD_WINDOW_SECONDS} seconds`;
    const row = rawDb.prepare(`
      SELECT
        COUNT(*) AS c,
        SUM(CASE WHEN handler_ok = 1 THEN 1 ELSE 0 END) AS ok_count,
        SUM(CASE WHEN handler_ok = 0 THEN 1 ELSE 0 END) AS fail_count,
        SUM(CASE WHEN hmac_valid = 0 THEN 1 ELSE 0 END) AS hmac_fail_count
      FROM shopify_webhook_events
      WHERE received_at > datetime('now', ?)
    `).get(sinceClause) as { c: number; ok_count: number; fail_count: number; hmac_fail_count: number };

    const total = row?.c ?? 0;
    if (total < FLOOD_THRESHOLD) return;

    const failCount = row?.fail_count ?? 0;
    const hmacFailCount = row?.hmac_fail_count ?? 0;
    const allHandlerOk = total > 0 && failCount === 0 && hmacFailCount === 0;
    const absurdVolume = total >= ABSURD_THRESHOLD;

    // Healthy high volume — skip the Slack post, but log for visibility.
    if (allHandlerOk && !absurdVolume) {
      console.log(`[shopify-webhook] high volume (${total}/${FLOOD_WINDOW_SECONDS}s), all handlers OK — no alert.`);
      return;
    }

    lastFloodAlertAt = Date.now();

    // Build the per-topic/per-shop breakdown so the Slack alert is
    // self-diagnostic — at a glance you can tell whether it's a real
    // spike, a loop, or something specific failing.
    const breakdown = rawDb.prepare(
      "SELECT topic, shop_domain AS shopDomain, COUNT(*) AS count FROM shopify_webhook_events WHERE received_at > datetime('now', ?) GROUP BY topic, shop_domain ORDER BY count DESC"
    ).all(sinceClause) as Array<{ topic: string; shopDomain: string | null; count: number }>;
    const { notifyWebhookFlood } = await import("@/modules/integrations/lib/slack/notifications");
    await notifyWebhookFlood({
      service: "Shopify",
      count: total,
      windowSeconds: FLOOD_WINDOW_SECONDS,
      breakdown,
      allHandlerOk,
    });
  } catch (e) {
    console.error("[shopify-webhook] flood detector error:", e);
  }
}
