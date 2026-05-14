/**
 * Handler for ShipHero's "Order Allocated" webhook topic.
 *
 * Pipeline (per docs/shiphero-webhooks-and-faire-slips.md):
 *
 *   1. Extract Shopify order_number + ShipHero order_id from payload.
 *   2. Match against Faire via display_id (strip leading "#").
 *      - No match → skip with status="skipped_not_faire", return ok.
 *   3. Probe the Faire packing-slip endpoint once to confirm the PDF is
 *      ready. Faire delays generation for pending-review orders.
 *      - Not ready → log "skipped_no_slip", return ok. Subsequent webhooks
 *        or manual replays will retry once Faire flips the order state.
 *   4. Idempotency check: if shiphero_attachment_logs already has a row
 *      with (shipheroOrderId, filename, status='success'), short-circuit.
 *   5. Mint a signed proxy URL and call ShipHero's order_add_attachment.
 *      ShipHero pulls the PDF from our proxy on its own schedule.
 *   6. Log the attempt (success or error) to shiphero_attachment_logs.
 *
 * Handlers always return ok=true once observability is recorded. We rely
 * on ShipHero NOT retrying on 200 to avoid infinite loops; the attachment
 * log + integrations UI is how we surface anything that needs human attention.
 */

import { sqlite } from "@/lib/db";
import type { WebhookPayload } from "@/modules/core/lib/webhooks";
import { registerShipHeroTopicHandler } from "./webhook-handlers";
import { findFaireOrderByOrderNumber } from "@/modules/integrations/lib/faire/order-matching";
import { fetchFairePackingSlip } from "@/modules/integrations/lib/faire/packing-slip";
import { mintPackingSlipUrl } from "@/modules/integrations/lib/faire/signed-url";
import { orderAddAttachment } from "./api-client";

type AttachmentStatus =
  | "success"
  | "error"
  | "skipped_not_faire"
  | "skipped_no_slip"
  | "skipped_no_order_id";

function logAttachment(opts: {
  shipheroOrderId: string;
  externalId: string | null;
  faireOrderId: string | null;
  filename: string;
  status: AttachmentStatus;
  errorMessage?: string | null;
}) {
  try {
    sqlite
      .prepare(
        `INSERT INTO shiphero_attachment_logs
         (id, shiphero_order_id, external_id, faire_order_id, filename, status, error_message, attached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        crypto.randomUUID(),
        opts.shipheroOrderId,
        opts.externalId,
        opts.faireOrderId,
        opts.filename,
        opts.status,
        opts.errorMessage ?? null,
      );
  } catch (e) {
    console.error("[shiphero/order-allocated] log insert failed:", e);
  }
}

function getAppBaseUrl(): string {
  const candidates = [
    process.env.SHOPIFY_APP_URL,
    process.env.APP_BASE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  ];
  for (const c of candidates) {
    if (c) return c.replace(/\/$/, "");
  }
  throw new Error(
    "App base URL not configured (set SHOPIFY_APP_URL or APP_BASE_URL)",
  );
}

async function handleOrderAllocated(
  payload: WebhookPayload,
): Promise<{ ok: boolean; message?: string }> {
  const body = payload.parsedBody as Record<string, unknown> | null;
  if (!body) return { ok: true, message: "Empty body" };

  const shipheroOrderId =
    (body["order_id"] as string | undefined) ||
    (body["id"] as string | undefined) ||
    null;
  const orderNumber =
    (body["order_number"] as string | undefined) ||
    (body["partner_order_id"] as string | undefined) ||
    null;

  if (!shipheroOrderId) {
    return { ok: true, message: "No order_id in payload" };
  }
  if (!orderNumber) {
    return { ok: true, message: "No order_number — cannot match to Faire" };
  }

  // 1. Match to Faire by display_id.
  let match: Awaited<ReturnType<typeof findFaireOrderByOrderNumber>>;
  try {
    match = await findFaireOrderByOrderNumber(orderNumber);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const filename = `Faire_Packing_Slip_${orderNumber.replace(/^#/, "")}.pdf`;
    logAttachment({
      shipheroOrderId,
      externalId: orderNumber,
      faireOrderId: null,
      filename,
      status: "error",
      errorMessage: `Faire match failed: ${msg}`,
    });
    return { ok: true, message: `Faire match failed: ${msg}` };
  }

  if (!match) {
    const filename = `Faire_Packing_Slip_${orderNumber.replace(/^#/, "")}.pdf`;
    logAttachment({
      shipheroOrderId,
      externalId: orderNumber,
      faireOrderId: null,
      filename,
      status: "skipped_not_faire",
    });
    return { ok: true, message: "Not a Faire order — skipped" };
  }

  const filename = `Faire_Packing_Slip_${match.displayId}.pdf`;

  // 2. Idempotency check — has a successful attach already happened for
  // this (order, filename) pair?
  const existing = sqlite
    .prepare(
      `SELECT 1 FROM shiphero_attachment_logs
       WHERE shiphero_order_id = ? AND filename = ? AND status = 'success'
       LIMIT 1`,
    )
    .get(shipheroOrderId, filename) as { 1: number } | undefined;
  if (existing) {
    return { ok: true, message: "Already attached — idempotent skip" };
  }

  // 3. Probe Faire for the PDF. Confirms the slip is ready before we ask
  // ShipHero to pull. Faire delays generation for orders still in review.
  try {
    const slip = await fetchFairePackingSlip(match.faireOrderId, {
      displayId: match.displayId,
    });
    if (!slip.pdf.byteLength) {
      logAttachment({
        shipheroOrderId,
        externalId: orderNumber,
        faireOrderId: match.faireOrderId,
        filename,
        status: "skipped_no_slip",
        errorMessage: "Empty PDF from Faire",
      });
      return { ok: true, message: "Faire returned empty PDF — skipped" };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logAttachment({
      shipheroOrderId,
      externalId: orderNumber,
      faireOrderId: match.faireOrderId,
      filename,
      status: "skipped_no_slip",
      errorMessage: msg,
    });
    return { ok: true, message: `Faire slip not ready: ${msg}` };
  }

  // 4. Mint signed proxy URL + call ShipHero.
  try {
    const baseUrl = getAppBaseUrl();
    const url = mintPackingSlipUrl({
      faireOrderId: match.faireOrderId,
      displayId: match.displayId,
      baseUrl,
    });

    await orderAddAttachment({
      orderId: shipheroOrderId,
      url,
      filename,
      fileType: "application/pdf",
      description: `Faire packing slip for ${match.displayId}`,
    });

    logAttachment({
      shipheroOrderId,
      externalId: orderNumber,
      faireOrderId: match.faireOrderId,
      filename,
      status: "success",
    });
    return { ok: true, message: `Attached Faire slip for ${match.displayId}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logAttachment({
      shipheroOrderId,
      externalId: orderNumber,
      faireOrderId: match.faireOrderId,
      filename,
      status: "error",
      errorMessage: msg,
    });
    // Return ok=true: we've recorded the failure for human review. Re-raising
    // would make ShipHero retry, but retries won't fix a Faire/credential
    // issue and would just spam the log.
    return { ok: true, message: `Attach error: ${msg}` };
  }
}

registerShipHeroTopicHandler("Order Allocated", handleOrderAllocated);
