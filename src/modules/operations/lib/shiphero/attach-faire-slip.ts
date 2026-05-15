/**
 * Shared "attach Faire packing slip + set packer note" pipeline.
 *
 * Called from:
 *   - The `Order Allocated` webhook handler (real-time, one order per fire).
 *   - scripts/backfill-faire-slips.ts (batch over existing orders).
 *
 * Same idempotency guarantees as the webhook path — re-running is safe.
 * Logs every attempt to shiphero_attachment_logs.
 *
 * See: docs/shiphero-webhooks-and-faire-slips.md
 */

import { sqlite } from "@/lib/db";
import { findFaireOrderByOrderNumber } from "@/modules/integrations/lib/faire/order-matching";
import { fetchFairePackingSlip } from "@/modules/integrations/lib/faire/packing-slip";
import { mintPackingSlipUrl } from "@/modules/integrations/lib/faire/signed-url";
import {
  orderAddAttachment,
  orderUpdatePackingNote,
  getOrderPackingNote,
} from "./api-client";
import {
  findLocalOrderIdByShipHeroSignals,
  logOrderActivity,
} from "@/modules/orders/lib/activity-log";

export type AttachStatus =
  | "success"
  | "error"
  | "skipped_not_faire"
  | "skipped_no_slip"
  | "skipped_no_order_id";

export interface AttachResult {
  status: AttachStatus;
  shipheroOrderId: string;
  externalId: string | null;
  faireOrderId: string | null;
  filename: string;
  message: string;
}

/** Note we set on the ShipHero order so the packer prints + includes the slip. */
export const FAIRE_PACKER_NOTE =
  "Faire wholesale order - Make sure to print the attached Faire packing list and place it in the package";

function getAppBaseUrl(): string {
  const candidates = [
    process.env.SHOPIFY_APP_URL,
    process.env.APP_BASE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  ];
  for (const c of candidates) {
    if (c) return c.replace(/\/$/, "");
  }
  throw new Error("App base URL not configured (set SHOPIFY_APP_URL or APP_BASE_URL)");
}

function logAttachment(opts: {
  shipheroOrderId: string;
  externalId: string | null;
  faireOrderId: string | null;
  filename: string;
  status: AttachStatus;
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
    console.error("[shiphero/attach-faire-slip] log insert failed:", e);
  }
  // Mirror onto the order activity timeline so the order detail page
  // shows what happened. Best-effort — if Shopify hasn't synced the
  // local order row yet (Order Allocated can beat Shopify webhooks),
  // we skip silently rather than block the attach.
  const orderId = findLocalOrderIdByShipHeroSignals({
    shipheroOrderId: opts.shipheroOrderId,
    externalId: opts.externalId,
    orderNumber: opts.externalId,
  });
  if (orderId) {
    logOrderActivity({
      orderId,
      eventType: `shiphero.slip.${opts.status}`,
      data: {
        filename: opts.filename,
        faireOrderId: opts.faireOrderId,
        errorMessage: opts.errorMessage ?? null,
      },
    });
  }
}

/**
 * Set the Faire packer note on a ShipHero order, but only if doing so
 * wouldn't clobber a human-authored note. We write if the existing note
 * is empty OR already contains our marker (so a re-run is a no-op).
 */
async function ensurePackerNote(shipheroOrderId: string): Promise<{ updated: boolean; reason: string }> {
  let current: string | null = null;
  try {
    current = await getOrderPackingNote(shipheroOrderId);
  } catch (e) {
    // Non-fatal — if the read fails, we skip the note update rather than
    // risking a clobber. Surface the reason via the return value.
    return { updated: false, reason: `read failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const trimmed = (current ?? "").trim();
  if (trimmed.includes("Faire wholesale order")) {
    return { updated: false, reason: "already set" };
  }
  if (trimmed && !trimmed.includes("Faire wholesale order")) {
    // Preserve a human-authored note. Append ours rather than replace, so
    // operations still sees their own note.
    const combined = `${trimmed}\n\n${FAIRE_PACKER_NOTE}`;
    await orderUpdatePackingNote({ orderId: shipheroOrderId, packingNote: combined });
    return { updated: true, reason: "appended to existing note" };
  }
  await orderUpdatePackingNote({ orderId: shipheroOrderId, packingNote: FAIRE_PACKER_NOTE });
  return { updated: true, reason: "set" };
}

/**
 * Run the full Faire attach pipeline for a single ShipHero order.
 *
 * Steps:
 *   1. Match the order to a Faire order via display_id (order_number).
 *      No match → status="skipped_not_faire".
 *   2. Idempotency: if shiphero_attachment_logs already has a success row
 *      for (shiphero_order_id, filename), short-circuit.
 *   3. Probe the Faire packing-slip endpoint to confirm the PDF is ready.
 *      Faire delays generation for pending-review orders.
 *      Not ready → status="skipped_no_slip".
 *   4. Mint a signed proxy URL + call ShipHero's order_add_attachment.
 *   5. Set/append the packer note via order_update.
 *   6. Log the attempt to shiphero_attachment_logs.
 */
export async function attachFairePackingSlipToOrder(opts: {
  /** ShipHero base64 order id, e.g. "T3JkZXI6MTIzNDU=". */
  shipheroOrderId: string;
  /** ShipHero order_number (Shopify channel order #), e.g. "#PEDBEMP4XK". */
  orderNumber: string | null;
}): Promise<AttachResult> {
  const { shipheroOrderId, orderNumber } = opts;

  if (!shipheroOrderId) {
    return {
      status: "skipped_no_order_id",
      shipheroOrderId: "",
      externalId: orderNumber,
      faireOrderId: null,
      filename: "",
      message: "Missing shipheroOrderId",
    };
  }
  if (!orderNumber) {
    return {
      status: "skipped_no_order_id",
      shipheroOrderId,
      externalId: null,
      faireOrderId: null,
      filename: "",
      message: "Missing order_number — cannot match to Faire",
    };
  }

  // 1. Match to Faire.
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
    return {
      status: "error",
      shipheroOrderId,
      externalId: orderNumber,
      faireOrderId: null,
      filename,
      message: `Faire match failed: ${msg}`,
    };
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
    return {
      status: "skipped_not_faire",
      shipheroOrderId,
      externalId: orderNumber,
      faireOrderId: null,
      filename,
      message: "Not a Faire order — skipped",
    };
  }

  const filename = `Faire_Packing_Slip_${match.displayId}.pdf`;

  // 2. Idempotency: skip if a previous attach already succeeded.
  const existing = sqlite
    .prepare(
      `SELECT 1 FROM shiphero_attachment_logs
       WHERE shiphero_order_id = ? AND filename = ? AND status = 'success'
       LIMIT 1`,
    )
    .get(shipheroOrderId, filename) as { 1: number } | undefined;
  if (existing) {
    // Still try to ensure the packer note is set. We may have attached the
    // slip in an earlier run before the note logic existed.
    let noteMsg = "";
    try {
      const noteResult = await ensurePackerNote(shipheroOrderId);
      noteMsg = noteResult.updated ? ` (note ${noteResult.reason})` : "";
    } catch (e) {
      noteMsg = ` (note set failed: ${e instanceof Error ? e.message : String(e)})`;
    }
    return {
      status: "success",
      shipheroOrderId,
      externalId: orderNumber,
      faireOrderId: match.faireOrderId,
      filename,
      message: `Already attached — idempotent skip${noteMsg}`,
    };
  }

  // 3. Probe Faire for the PDF — confirms readiness before we ask ShipHero
  // to pull. Faire delays generation for orders still in review.
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
      return {
        status: "skipped_no_slip",
        shipheroOrderId,
        externalId: orderNumber,
        faireOrderId: match.faireOrderId,
        filename,
        message: "Faire returned empty PDF",
      };
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
    return {
      status: "skipped_no_slip",
      shipheroOrderId,
      externalId: orderNumber,
      faireOrderId: match.faireOrderId,
      filename,
      message: `Faire slip not ready: ${msg}`,
    };
  }

  // 4. Mint signed proxy URL + call ShipHero attach.
  try {
    const url = mintPackingSlipUrl({
      faireOrderId: match.faireOrderId,
      displayId: match.displayId,
      baseUrl: getAppBaseUrl(),
    });
    await orderAddAttachment({
      orderId: shipheroOrderId,
      url,
      filename,
      fileType: "application/pdf",
      description: `Faire packing slip for ${match.displayId}`,
    });
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
    return {
      status: "error",
      shipheroOrderId,
      externalId: orderNumber,
      faireOrderId: match.faireOrderId,
      filename,
      message: `Attach error: ${msg}`,
    };
  }

  // 5. Set the packer note. Don't fail the whole attach if this fails —
  // the slip is already on the order. Worst case, the packer doesn't see
  // the instruction and we surface the issue in the audit log.
  let noteSuffix = "";
  try {
    const noteResult = await ensurePackerNote(shipheroOrderId);
    noteSuffix = noteResult.updated ? `, note ${noteResult.reason}` : `, note ${noteResult.reason}`;
  } catch (e) {
    noteSuffix = `, note set failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  // 6. Log success.
  logAttachment({
    shipheroOrderId,
    externalId: orderNumber,
    faireOrderId: match.faireOrderId,
    filename,
    status: "success",
  });
  return {
    status: "success",
    shipheroOrderId,
    externalId: orderNumber,
    faireOrderId: match.faireOrderId,
    filename,
    message: `Attached Faire slip for ${match.displayId}${noteSuffix}`,
  };
}
