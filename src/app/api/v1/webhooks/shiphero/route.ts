export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { db, sqlite } from "@/lib/db";
import {
  shipheroWebhookEvents,
  shipheroWebhookSubscriptions,
} from "@/modules/operations/schema/shiphero";
import { eq } from "drizzle-orm";
import { webhookRegistry } from "@/modules/core/lib/webhooks";

// Ensure the ShipHero handler is registered (Phase 3 will populate this).
import "@/modules/operations/lib/shiphero/webhook-handlers";

/**
 * POST /api/v1/webhooks/shiphero
 *
 * Single entry point for every ShipHero webhook subscription created via the
 * `webhook_create` mutation. Topics we currently subscribe to:
 *   - "Order Allocated"  → triggers Faire packing-slip attach
 *   - "Shipment Update"  → mirrors tracking + status into local orders table
 *
 * Always logs the event to shiphero_webhook_events for observability before
 * dispatching to the registered handler. HMAC failures are logged with
 * hmac_valid = 0 and rejected with 401; never dispatched.
 *
 * See docs/shiphero-webhooks-and-faire-slips.md for the full integration
 * context.
 */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });

  // ShipHero puts topic in the body (or sometimes a header — we accept both).
  // Examples seen: "Order Allocated", "Shipment Update".
  let parsedBody: Record<string, unknown> | null = null;
  try {
    parsedBody = JSON.parse(body) as Record<string, unknown>;
  } catch {
    await logEvent({
      topic: headers["x-shiphero-topic"] || null,
      shipheroId: null,
      externalId: null,
      triggeredAt: null,
      hmacValid: false,
      handlerOk: false,
      handlerMessage: "Invalid JSON",
      payloadSize: body.length,
      payloadPreview: body.slice(0, 500),
    });
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const topic =
    (parsedBody?.["webhook_type"] as string | undefined) ||
    (parsedBody?.["topic"] as string | undefined) ||
    headers["x-shiphero-topic"] ||
    null;

  // Extract identifying fields we care about for cross-referencing.
  // ShipHero's payload shapes vary by topic; pull what we can defensively.
  const shipheroId =
    (parsedBody?.["order_id"] as string | undefined) ||
    (parsedBody?.["id"] as string | undefined) ||
    null;
  const externalId =
    (parsedBody?.["order_number"] as string | undefined) ||
    (parsedBody?.["partner_order_id"] as string | undefined) ||
    null;
  const triggeredAt =
    (parsedBody?.["triggered_at"] as string | undefined) ||
    (parsedBody?.["timestamp"] as string | undefined) ||
    null;

  // HMAC verification — ShipHero signs with the per-subscription shared
  // secret returned by webhook_create. Header name (per ShipHero docs):
  // x-shiphero-hmac-sha256. We look up the secret by topic.
  const signatureHeader =
    headers["x-shiphero-hmac-sha256"] ||
    headers["x-shiphero-signature"] ||
    headers["shiphero-hmac-sha256"] ||
    "";

  const hmacValid = topic ? verifyShipHeroHmac(body, signatureHeader, topic) : false;

  if (!hmacValid) {
    await logEvent({
      topic,
      shipheroId,
      externalId,
      triggeredAt,
      hmacValid: false,
      handlerOk: false,
      handlerMessage: signatureHeader
        ? "HMAC verification failed"
        : "Missing signature header",
      payloadSize: body.length,
      payloadPreview: body.slice(0, 500),
    });
    return NextResponse.json({ error: "Invalid HMAC" }, { status: 401 });
  }

  const handler = webhookRegistry.getHandler("shiphero");
  if (!handler) {
    await logEvent({
      topic,
      shipheroId,
      externalId,
      triggeredAt,
      hmacValid: true,
      handlerOk: false,
      handlerMessage: "ShipHero handler not registered",
      payloadSize: body.length,
      payloadPreview: body.slice(0, 500),
    });
    // 200 anyway — ShipHero will retry on non-2xx and we don't want a
    // missing handler to cause infinite delivery loops. The event is logged
    // and visible in the settings UI.
    return NextResponse.json({ ok: false, error: "Handler not registered" });
  }

  let handlerOk = true;
  let handlerMessage: string | null = null;

  try {
    const result = await handler({
      provider: "shiphero",
      headers,
      body,
      parsedBody,
    });
    handlerOk = !!result.ok;
    handlerMessage = result.message ?? null;
  } catch (err) {
    handlerOk = false;
    handlerMessage = err instanceof Error ? err.message : String(err);
    console.error("[ShipHero Webhook] Handler threw:", err);
  }

  await logEvent({
    topic,
    shipheroId,
    externalId,
    triggeredAt,
    hmacValid: true,
    handlerOk,
    handlerMessage,
    payloadSize: body.length,
    payloadPreview: body.slice(0, 500),
  });

  // Per the docs/idempotency section: handlers that decline to act
  // (e.g. "no Faire match") should still return ok=true so ShipHero
  // doesn't retry. Real failures (handlerOk=false) return 500 to trigger
  // the retry.
  if (!handlerOk) {
    return NextResponse.json(
      { ok: false, error: handlerMessage || "Handler returned error" },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}

/**
 * Verify a ShipHero webhook HMAC.
 *
 * ShipHero signs the raw body with HMAC-SHA256 using the per-subscription
 * shared_secret that webhook_create returned at registration time. We look
 * up the secret by topic (the subscription's `name` field — see api-client).
 * The signature is hex-encoded (NOT base64 like Shopify).
 */
function verifyShipHeroHmac(body: string, signature: string, topic: string): boolean {
  if (!signature) return false;
  try {
    // Drizzle would work here but the receiver is hot-path; use raw sqlite.
    const row = sqlite
      .prepare(
        `SELECT shared_secret FROM shiphero_webhook_subscriptions
         WHERE topic = ? AND shared_secret IS NOT NULL AND deactivated_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(topic) as { shared_secret: string } | undefined;
    if (!row?.shared_secret) return false;

    const expected = createHmac("sha256", row.shared_secret).update(body, "utf8").digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature.trim().toLowerCase());
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch (e) {
    console.error("[shiphero-webhook] HMAC verify error:", e);
    return false;
  }
}

type LogPayload = {
  topic: string | null;
  shipheroId: string | null;
  externalId: string | null;
  triggeredAt: string | null;
  hmacValid: boolean;
  handlerOk: boolean;
  handlerMessage: string | null;
  payloadSize: number;
  payloadPreview: string;
};

async function logEvent(p: LogPayload) {
  try {
    await db.insert(shipheroWebhookEvents).values({
      topic: p.topic,
      shipheroId: p.shipheroId,
      externalId: p.externalId,
      triggeredAt: p.triggeredAt,
      hmacValid: p.hmacValid,
      handlerOk: p.handlerOk,
      handlerMessage: p.handlerMessage,
      payloadSize: p.payloadSize,
      payloadPreview: p.payloadPreview,
    });
  } catch (err) {
    console.error("[ShipHero Webhook] Failed to log event:", err);
  }
  void detectFlood();
}

// Silence the unused-import warning from drizzle helpers we keep imported
// for downstream extension. (eq + shipheroWebhookSubscriptions are referenced
// in the registration script that lands in Phase 4.)
void eq;
void shipheroWebhookSubscriptions;

// ── Flood detector ──
// Mirrors the Shopify pattern: alert only when there's a real signal
// (HMAC fails, handler fails, or absurd volume). Healthy backlog drains
// are silent.

let lastFloodAlertAt = 0;
const FLOOD_THRESHOLD = 50;          // ShipHero is lower-volume than Shopify
const ABSURD_THRESHOLD = 500;
const FLOOD_WINDOW_SECONDS = 60;
const FLOOD_COOLDOWN_MS = 10 * 60_000;

async function detectFlood(): Promise<void> {
  if (Date.now() - lastFloodAlertAt < FLOOD_COOLDOWN_MS) return;
  try {
    const sinceClause = `-${FLOOD_WINDOW_SECONDS} seconds`;
    const row = sqlite.prepare(`
      SELECT
        COUNT(*) AS c,
        SUM(CASE WHEN handler_ok = 1 THEN 1 ELSE 0 END) AS ok_count,
        SUM(CASE WHEN handler_ok = 0 THEN 1 ELSE 0 END) AS fail_count,
        SUM(CASE WHEN hmac_valid = 0 THEN 1 ELSE 0 END) AS hmac_fail_count
      FROM shiphero_webhook_events
      WHERE received_at > datetime('now', ?)
    `).get(sinceClause) as { c: number; ok_count: number; fail_count: number; hmac_fail_count: number };

    const total = row?.c ?? 0;
    if (total < FLOOD_THRESHOLD) return;

    const failCount = row?.fail_count ?? 0;
    const hmacFailCount = row?.hmac_fail_count ?? 0;
    const allHandlerOk = total > 0 && failCount === 0 && hmacFailCount === 0;
    const absurdVolume = total >= ABSURD_THRESHOLD;

    if (allHandlerOk && !absurdVolume) {
      console.log(`[shiphero-webhook] high volume (${total}/${FLOOD_WINDOW_SECONDS}s), all handlers OK — no alert.`);
      return;
    }

    lastFloodAlertAt = Date.now();

    const breakdown = sqlite.prepare(
      "SELECT topic, NULL AS shopDomain, COUNT(*) AS count FROM shiphero_webhook_events WHERE received_at > datetime('now', ?) GROUP BY topic ORDER BY count DESC",
    ).all(sinceClause) as Array<{ topic: string; shopDomain: string | null; count: number }>;
    const { notifyWebhookFlood } = await import("@/modules/integrations/lib/slack/notifications");
    await notifyWebhookFlood({
      service: "ShipHero",
      count: total,
      windowSeconds: FLOOD_WINDOW_SECONDS,
      breakdown,
      allHandlerOk,
    });
  } catch (e) {
    console.error("[shiphero-webhook] flood detector error:", e);
  }
}
