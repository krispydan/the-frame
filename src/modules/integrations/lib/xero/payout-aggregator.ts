/**
 * Aggregates the raw transactions of a Shopify payout into a structured
 * PayoutSummary the manual journal builder can consume.
 *
 * The Shopify Payments API returns one row per balance event (charge,
 * refund, fee, adjustment, dispute, etc.). We bucket them into the
 * categories defined in the mapping guide so each becomes one journal line.
 */

import type {
  ShopifyPayout,
  ShopifyPayoutTransaction,
} from "./shopify-payouts";

export type PayoutCategoryAmount = {
  category: string;        // matches xero_account_mappings.category
  amount: number;          // positive number; the journal builder applies side
  txCount: number;         // how many source transactions rolled into this bucket
};

export type PayoutSummary = {
  payoutId: number;
  payoutDate: string;             // YYYY-MM-DD
  currency: string;
  netPayoutAmount: number;        // matches the Shopify payout.amount
  /** Logical platform: "shopify_dtc" | "shopify_afterpay" | "shopify_wholesale". */
  platform: string;

  /** Buckets by category. Empty buckets are excluded. */
  categories: PayoutCategoryAmount[];

  /** All distinct order IDs present in the payout — used by the COGS aggregator. */
  orderIds: number[];

  /** Validation: payout amount minus the sum of buckets (should be ~0). */
  reconciliationDelta: number;

  /** Whether this payout was an Afterpay settlement (different fee account). */
  isAfterpayPayout: boolean;
};

const PARSE = (s: string): number => {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Detects Afterpay payouts.
 *
 * Shopify Payments and Afterpay payouts both come through the same endpoint,
 * but Afterpay charges have different transaction sources/types. The simplest
 * heuristic that's worked in production: check the `source_type` of charge
 * transactions — Afterpay shows `afterpay_credit_payment` (or similar) on its
 * charges, while standard Shopify Payments shows `Order` / `Refund`.
 *
 * If we can't tell, default to NOT Afterpay.
 */
function detectAfterpay(txs: ShopifyPayoutTransaction[]): boolean {
  return txs.some(
    (t) => typeof t.source_type === "string" && /afterpay/i.test(t.source_type),
  );
}

/**
 * Aggregate a single Shopify payout's transactions into a PayoutSummary.
 *
 * Categories produced (matching mapping-guide categories):
 *   sales       — sum of charge gross
 *   refunds     — sum of refund gross (positive number; journal builder
 *                 will apply debit side)
 *   fees        — sum of charge fees + refund fees + dispute fees
 *   adjustments — sum of adjustment amounts (positive or negative)
 *   clearing    — net payout amount (debits the clearing account)
 *
 * Note: Shopify Payments transactions do NOT split shipping or tax — those
 * are inside the gross charge amount. To split shipping/tax we'd need to
 * cross-reference each source_order_id with the order line items, which is
 * Phase 2.5+ scope. For v1, sales bucket = total gross charges, and
 * shipping/tax mappings are unused on the Shopify side (they'll be used by
 * the order-level COGS aggregator in Phase 2b which already has order data).
 */
export function aggregatePayoutTransactions(
  payout: ShopifyPayout,
  txs: ShopifyPayoutTransaction[],
  basePlatform: "shopify_dtc" | "shopify_wholesale",
): PayoutSummary {
  const isAfterpay = basePlatform === "shopify_dtc" && detectAfterpay(txs);
  const platform = isAfterpay ? "shopify_afterpay" : basePlatform;

  let salesGross = 0;
  let salesCount = 0;
  let refundsGross = 0;
  let refundsCount = 0;
  let fees = 0;
  let feeCount = 0;
  let adjustments = 0;
  let adjustmentCount = 0;
  const orderIds = new Set<number>();

  for (const tx of txs) {
    const amount = PARSE(tx.amount);
    const fee = PARSE(tx.fee);

    if (tx.source_order_id) orderIds.add(tx.source_order_id);

    switch (tx.type) {
      case "charge":
        salesGross += amount;
        salesCount += 1;
        if (fee !== 0) {
          fees += fee;
          feeCount += 1;
        }
        break;
      case "refund":
        // Refunds come in as negative amounts in Shopify Payments
        refundsGross += Math.abs(amount);
        refundsCount += 1;
        if (fee !== 0) {
          fees += fee;
          feeCount += 1;
        }
        break;
      case "fee":
        fees += Math.abs(amount);
        feeCount += 1;
        break;
      case "adjustment":
      case "dispute":
      case "reserve_hold":
      case "reserve_release":
      case "advance":
      case "advance_funding":
        adjustments += amount;  // can be positive or negative
        adjustmentCount += 1;
        break;
      case "payout":
        // The payout transaction itself — skip, we already have the net amount
        // from payout.amount.
        break;
    }
  }

  const netPayout = PARSE(payout.amount);
  const categories: PayoutCategoryAmount[] = [];
  if (salesGross !== 0)   categories.push({ category: "sales",       amount: round2(salesGross),  txCount: salesCount });
  if (refundsGross !== 0) categories.push({ category: "refunds",     amount: round2(refundsGross), txCount: refundsCount });
  if (fees !== 0)         categories.push({ category: "fees",        amount: round2(fees),        txCount: feeCount });
  if (adjustments !== 0)  categories.push({ category: "adjustments", amount: round2(adjustments), txCount: adjustmentCount });
  if (netPayout !== 0)    categories.push({ category: "clearing",    amount: round2(netPayout),   txCount: 1 });

  // Validation: gross sales - refunds - fees + adjustments should ~= net payout
  const computed = salesGross - refundsGross - fees + adjustments;
  const reconciliationDelta = round2(computed - netPayout);

  return {
    payoutId: payout.id,
    payoutDate: payout.date,
    currency: payout.currency,
    netPayoutAmount: round2(netPayout),
    platform,
    categories,
    orderIds: Array.from(orderIds),
    reconciliationDelta,
    isAfterpayPayout: isAfterpay,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
