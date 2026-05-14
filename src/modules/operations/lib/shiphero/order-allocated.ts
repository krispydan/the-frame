/**
 * Handler for ShipHero's "Order Allocated" webhook topic.
 *
 * Thin wrapper around attachFairePackingSlipToOrder() in attach-faire-slip.ts
 * — that's the shared pipeline used by both this real-time path and the
 * batch backfill script (scripts/backfill-faire-slips.ts).
 *
 * Always returns ok=true so ShipHero never retries on 200. All outcomes
 * (success, skipped, error) are persisted to shiphero_attachment_logs by
 * the helper and surfaced in the integrations UI.
 */

import type { WebhookPayload } from "@/modules/core/lib/webhooks";
import { registerShipHeroTopicHandler } from "./webhook-handlers";
import { attachFairePackingSlipToOrder } from "./attach-faire-slip";

async function handleOrderAllocated(
  payload: WebhookPayload,
): Promise<{ ok: boolean; message?: string }> {
  const body = payload.parsedBody as Record<string, unknown> | null;
  if (!body) return { ok: true, message: "Empty body" };

  const shipheroOrderId =
    (body["order_id"] as string | undefined) ||
    (body["id"] as string | undefined) ||
    "";
  const orderNumber =
    (body["order_number"] as string | undefined) ||
    (body["partner_order_id"] as string | undefined) ||
    null;

  const result = await attachFairePackingSlipToOrder({
    shipheroOrderId,
    orderNumber,
  });
  return { ok: true, message: result.message };
}

registerShipHeroTopicHandler("Order Allocated", handleOrderAllocated);
