/**
 * ShipHero webhook handler registration.
 *
 * The receiver at /api/v1/webhooks/shiphero looks up handlers via the
 * shared webhookRegistry. This file registers a single "shiphero" handler
 * that fans out by topic to the per-topic handlers in Phase 3:
 *
 *   - "Order Allocated"  → attach Faire packing slip
 *   - "Shipment Update"  → sync order status + tracking into local orders
 *
 * Phase 1C lands the dispatch skeleton only. Phase 3 wires the actual
 * topic handlers — until then we log + return ok so ShipHero doesn't
 * retry forever while we're still building.
 */

import { webhookRegistry, type WebhookPayload } from "@/modules/core/lib/webhooks";

type TopicHandler = (payload: WebhookPayload) => Promise<{ ok: boolean; message?: string }>;

const topicHandlers = new Map<string, TopicHandler>();

/**
 * Register a per-topic handler. Topic strings must match ShipHero's
 * webhook `name` exactly (e.g. "Order Allocated", "Shipment Update").
 * Phase 3 modules call this at import time.
 */
export function registerShipHeroTopicHandler(topic: string, handler: TopicHandler) {
  topicHandlers.set(topic, handler);
}

webhookRegistry.register("shiphero", async (payload) => {
  // Lazy-load topic handlers via dynamic side-effect imports. Each handler
  // registers itself with registerShipHeroTopicHandler() at module init.
  // We do this inside the registry callback (instead of at file top) to
  // avoid circular import loops between this module and the handlers.
  await import("./order-allocated");
  await import("./shipment-update");

  const body = payload.parsedBody as Record<string, unknown> | null;
  const topic =
    (body?.["webhook_type"] as string | undefined) ||
    (body?.["topic"] as string | undefined) ||
    payload.headers["x-shiphero-topic"] ||
    null;

  if (!topic) {
    return { ok: true, message: "No topic — accepted but ignored" };
  }

  const handler = topicHandlers.get(topic);
  if (!handler) {
    // Unknown / unsubscribed topic: accept (200) so ShipHero doesn't retry,
    // but record in the message column so the integrations UI can flag it.
    return { ok: true, message: `No handler for topic "${topic}"` };
  }

  return handler(payload);
});
