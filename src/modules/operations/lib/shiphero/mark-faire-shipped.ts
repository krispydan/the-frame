/**
 * Mark a Faire order as shipped (US auto, non-US manual alert).
 *
 * Called from shipment-update.ts behind the non-shipped → shipped
 * transition gate. Self-contained pipeline:
 *
 *   1. Bail out if the local order isn't a candidate (channel isn't
 *      wholesale/faire, order_number doesn't look like a Faire display id,
 *      or tracking info is missing).
 *   2. Match the order_number to a Faire order id via the existing
 *      findFaireOrderByOrderNumber. That call now also returns
 *      shipToCountry.
 *   3. If country is non-US: post the manual-ship Slack alert + log
 *      status=skipped_non_us. Done.
 *   4. If country is US: normalize the carrier (skip + alert on unknown),
 *      compute postage from the configurable tier table, POST the
 *      shipment to Faire's API, and log the outcome.
 *
 * Idempotency: a unique partial index on faire_shipment_marks prevents
 * double-success rows. We also short-circuit if a success row already
 * exists.
 */

import { sqlite } from "@/lib/db";
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { orders } from "@/modules/orders/schema";
import { findFaireOrderByOrderNumber } from "@/modules/integrations/lib/faire/order-matching";
import {
  markFaireOrderShipped,
  normalizeCarrierForFaire,
} from "@/modules/integrations/lib/faire/shipments";
import { getPostageCentsForOrderTotal } from "@/modules/integrations/lib/faire/postage-tiers";
import { logOrderActivity } from "@/modules/orders/lib/activity-log";

type MarkStatus =
  | "success"
  | "error"
  | "skipped_non_us"
  | "skipped_unknown_carrier"
  | "skipped_no_tracking"
  | "skipped_not_faire"
  | "skipped_no_order"
  | "skipped_already_marked";

function logMark(opts: {
  /** Local orders.id. When present, the same event is mirrored onto the
   *  order activity feed so /orders/[id] shows what happened. */
  localOrderId?: string | null;
  faireOrderId: string | null;
  orderNumber: string | null;
  countryCode: string | null;
  carrier: string | null;
  trackingCode: string | null;
  makerCostCents: number | null;
  status: MarkStatus;
  responseStatus?: number | null;
  responseBody?: unknown;
  errorMessage?: string | null;
}) {
  try {
    sqlite
      .prepare(
        `INSERT INTO faire_shipment_marks
         (id, faire_order_id, order_number, country_code, carrier, tracking_code,
          maker_cost_cents, status, response_status, response_body, error_message, marked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        crypto.randomUUID(),
        opts.faireOrderId,
        opts.orderNumber,
        opts.countryCode,
        opts.carrier,
        opts.trackingCode,
        opts.makerCostCents,
        opts.status,
        opts.responseStatus ?? null,
        opts.responseBody == null
          ? null
          : typeof opts.responseBody === "string"
          ? opts.responseBody.slice(0, 2000)
          : JSON.stringify(opts.responseBody).slice(0, 2000),
        opts.errorMessage ?? null,
      );
  } catch (e) {
    console.error("[mark-faire-shipped] log insert failed:", e);
  }
  // Mirror onto the order activity timeline.
  if (opts.localOrderId) {
    logOrderActivity({
      orderId: opts.localOrderId,
      eventType: `faire.ship_mark.${opts.status}`,
      data: {
        faireOrderId: opts.faireOrderId,
        countryCode: opts.countryCode,
        carrier: opts.carrier,
        trackingCode: opts.trackingCode,
        makerCostCents: opts.makerCostCents,
        responseStatus: opts.responseStatus ?? null,
        errorMessage: opts.errorMessage ?? null,
      },
    });
  }
}

interface MarkFaireShippedArgs {
  /** Local orders.id. */
  localOrderId: string;
  /** Order number from the webhook payload. */
  orderNumber: string | null;
  /** Tracking number from the webhook payload. */
  trackingNumber: string | null;
  /** Carrier string from the webhook payload (e.g. "UPS", "USPS Ground"). */
  carrier: string | null;
}

export async function markFaireShippedIfApplicable(
  args: MarkFaireShippedArgs,
): Promise<MarkStatus> {
  if (!args.orderNumber) {
    return "skipped_not_faire";
  }
  if (!args.trackingNumber) {
    logMark({
      localOrderId: args.localOrderId,
      faireOrderId: null,
      orderNumber: args.orderNumber,
      countryCode: null,
      carrier: args.carrier,
      trackingCode: null,
      makerCostCents: null,
      status: "skipped_no_tracking",
      errorMessage: "Tracking number missing from ShipHero webhook payload",
    });
    return "skipped_no_tracking";
  }

  // Pull the local order to get the channel + total.
  const local = db.select().from(orders).where(eq(orders.id, args.localOrderId)).get();
  if (!local) {
    return "skipped_no_order";
  }

  // Faire-sourced orders flow through the wholesale channel. Plain DTC
  // wholesale orders without Faire's display_id pattern are also skipped
  // by the regex inside findFaireOrderByOrderNumber.
  if (local.channel !== "shopify_wholesale" && local.channel !== "faire") {
    return "skipped_not_faire";
  }

  // Resolve Faire order id + ship-to country. Bounded paginate cost is
  // negligible since this fires once per shipment.
  let match: Awaited<ReturnType<typeof findFaireOrderByOrderNumber>>;
  try {
    match = await findFaireOrderByOrderNumber(args.orderNumber);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logMark({
      localOrderId: args.localOrderId,
      faireOrderId: null,
      orderNumber: args.orderNumber,
      countryCode: null,
      carrier: args.carrier,
      trackingCode: args.trackingNumber,
      makerCostCents: null,
      status: "error",
      errorMessage: `Faire match failed: ${msg}`,
    });
    return "error";
  }
  if (!match) {
    return "skipped_not_faire";
  }

  // Idempotency check.
  const existing = sqlite
    .prepare(
      `SELECT 1 FROM faire_shipment_marks
       WHERE faire_order_id = ? AND status = 'success' LIMIT 1`,
    )
    .get(match.faireOrderId) as { 1: number } | undefined;
  if (existing) {
    return "skipped_already_marked";
  }

  // Non-US: send a manual-ship Slack alert + log. We don't auto-mark
  // until we've nailed down the Canadian postage rates.
  const country = match.shipToCountry || null;
  const isUS = country === "US" || country === "USA" || country === "UNITED STATES";
  if (!isUS) {
    logMark({
      localOrderId: args.localOrderId,
      faireOrderId: match.faireOrderId,
      orderNumber: args.orderNumber,
      countryCode: country,
      carrier: args.carrier,
      trackingCode: args.trackingNumber,
      makerCostCents: null,
      status: "skipped_non_us",
    });
    try {
      const { notifyFaireManualShipRequired, faireOrderUrlFromName } = await import(
        "@/modules/integrations/lib/slack/notifications"
      );
      await notifyFaireManualShipRequired({
        orderNumber: args.orderNumber,
        faireDisplayId: match.displayId,
        countryCode: country,
        trackingNumber: args.trackingNumber,
        trackingCarrier: args.carrier,
        faireUrl: faireOrderUrlFromName(args.orderNumber),
      });
    } catch (e) {
      console.error("[mark-faire-shipped] manual-ship Slack alert failed:", e);
    }
    return "skipped_non_us";
  }

  // US: normalize the carrier. Unknown carriers → manual alert, not a
  // guess. Faire reconciles on carrier; bad data is worse than no auto-mark.
  const faireCarrier = normalizeCarrierForFaire(args.carrier);
  if (!faireCarrier) {
    logMark({
      localOrderId: args.localOrderId,
      faireOrderId: match.faireOrderId,
      orderNumber: args.orderNumber,
      countryCode: country,
      carrier: args.carrier,
      trackingCode: args.trackingNumber,
      makerCostCents: null,
      status: "skipped_unknown_carrier",
      errorMessage: `Unrecognized carrier "${args.carrier}" — manual mark required`,
    });
    try {
      const { notifyFaireManualShipRequired, faireOrderUrlFromName } = await import(
        "@/modules/integrations/lib/slack/notifications"
      );
      await notifyFaireManualShipRequired({
        orderNumber: args.orderNumber,
        faireDisplayId: match.displayId,
        countryCode: country,
        trackingNumber: args.trackingNumber,
        trackingCarrier: args.carrier,
        faireUrl: faireOrderUrlFromName(args.orderNumber),
      });
    } catch (e) {
      console.error("[mark-faire-shipped] unknown-carrier Slack alert failed:", e);
    }
    return "skipped_unknown_carrier";
  }

  // Compute postage from the configurable tier table.
  const makerCostCents = getPostageCentsForOrderTotal(local.total);

  // POST to Faire.
  try {
    const result = await markFaireOrderShipped({
      faireOrderId: match.faireOrderId,
      trackingCode: args.trackingNumber,
      carrier: faireCarrier,
      makerCostCents,
    });
    logMark({
      localOrderId: args.localOrderId,
      faireOrderId: match.faireOrderId,
      orderNumber: args.orderNumber,
      countryCode: country,
      carrier: faireCarrier,
      trackingCode: args.trackingNumber,
      makerCostCents,
      status: result.ok ? "success" : "error",
      responseStatus: result.status,
      responseBody: result.body,
      errorMessage: result.ok
        ? null
        : `Faire returned HTTP ${result.status}: ${
            typeof result.body === "string"
              ? result.body.slice(0, 200)
              : JSON.stringify(result.body).slice(0, 200)
          }`,
    });
    return result.ok ? "success" : "error";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logMark({
      localOrderId: args.localOrderId,
      faireOrderId: match.faireOrderId,
      orderNumber: args.orderNumber,
      countryCode: country,
      carrier: faireCarrier,
      trackingCode: args.trackingNumber,
      makerCostCents,
      status: "error",
      errorMessage: msg,
    });
    return "error";
  }
}
