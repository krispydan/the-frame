/**
 * Shopify Payments API helpers — payouts and their transactions.
 *
 * The Shopify Payments API exposes payout objects and the transactions that
 * make them up. Each payout becomes one Xero manual journal in Phase 2.
 *
 * REST endpoints (Admin API):
 *   GET /admin/api/{version}/shopify_payments/payouts.json
 *   GET /admin/api/{version}/shopify_payments/payouts/{id}/transactions.json
 *
 * Both return JSON when Accept: application/json is set (handled by the
 * `getShopifyClientByChannel` REST wrapper).
 */

import { getShopifyClientByChannel } from "@/modules/integrations/lib/shopify/admin-api";

export type ShopifyPayoutStatus = "scheduled" | "in_transit" | "paid" | "failed" | "cancelled";

export type ShopifyPayout = {
  id: number;
  status: ShopifyPayoutStatus;
  date: string;            // YYYY-MM-DD payout date
  currency: string;
  amount: string;          // net payout amount as decimal string
  summary: {
    adjustments_fee_amount: string;
    adjustments_gross_amount: string;
    charges_fee_amount: string;
    charges_gross_amount: string;
    refunds_fee_amount: string;
    refunds_gross_amount: string;
    reserved_funds_fee_amount: string;
    reserved_funds_gross_amount: string;
    retried_payouts_fee_amount: string;
    retried_payouts_gross_amount: string;
  };
};

export type ShopifyPayoutTransactionType =
  | "charge" | "refund" | "dispute" | "adjustment" | "advance" | "advance_funding"
  | "payout" | "fee" | "reserve_hold" | "reserve_release";

export type ShopifyPayoutTransaction = {
  id: number;
  type: ShopifyPayoutTransactionType;
  test: boolean;
  payout_id: number;
  payout_status: string;
  currency: string;
  amount: string;          // gross
  fee: string;             // processor fee
  net: string;             // amount - fee
  source_id: number | null;       // points to the order/refund/etc.
  source_type: string | null;
  source_order_id: number | null;
  source_order_transaction_id: number | null;
  processed_at: string | null;
};

/**
 * Fetch payouts from a Shopify shop within a date range.
 *
 * @param channel  the connected shop's channel ("retail" or "wholesale")
 * @param opts     date_min / date_max in ISO date format YYYY-MM-DD
 *                 status filter (default "paid" — only finalised payouts)
 *                 limit (default 50, Shopify max 250)
 */
export async function fetchShopifyPayouts(
  channel: string,
  opts: {
    dateMin?: string;
    dateMax?: string;
    status?: ShopifyPayoutStatus | "all";
    limit?: number;
  } = {},
): Promise<ShopifyPayout[]> {
  const client = await getShopifyClientByChannel(channel);
  const qs = new URLSearchParams();
  qs.set("limit", String(opts.limit || 50));
  if (opts.dateMin) qs.set("date_min", opts.dateMin);
  if (opts.dateMax) qs.set("date_max", opts.dateMax);
  if (opts.status && opts.status !== "all") qs.set("status", opts.status);
  // Default to finalised payouts so we don't post journals for in-transit ones
  if (!opts.status) qs.set("status", "paid");

  const data = (await client.rest("GET", `/shopify_payments/payouts.json?${qs}`)) as {
    payouts?: ShopifyPayout[];
  };
  return data.payouts || [];
}

/**
 * Fetch the transactions that make up a single payout.
 * Used to break the payout total into sales / fees / refunds / adjustments.
 */
export async function fetchShopifyPayoutTransactions(
  channel: string,
  payoutId: number,
): Promise<ShopifyPayoutTransaction[]> {
  const client = await getShopifyClientByChannel(channel);
  // Shopify caps page size at 250 — payouts rarely have more, but loop just in case.
  const all: ShopifyPayoutTransaction[] = [];
  let sinceId: number | null = null;
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams();
    qs.set("payout_id", String(payoutId));
    qs.set("limit", "250");
    if (sinceId) qs.set("since_id", String(sinceId));

    const data = (await client.rest(
      "GET",
      `/shopify_payments/balance/transactions.json?${qs}`,
    )) as { transactions?: ShopifyPayoutTransaction[] };

    const batch = data.transactions || [];
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 250) break;
    sinceId = batch[batch.length - 1].id;
  }
  return all;
}
