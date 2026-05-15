/**
 * Faire payout data is exposed PER ORDER on /external-api/v2/orders, not via
 * a top-level /payouts endpoint (Faire doesn't have one). Each order's
 * `payout_costs` object carries the full breakdown — fee, commission,
 * shipping reimbursement, brand discount, net payout to bank.
 *
 * This module:
 *   1. Fetches Faire orders (paginated, cursor-based)
 *   2. Normalises one order's payout_costs into a flat summary the journal
 *      builder can post to Xero
 *
 * The orchestrator (./payout-sync.ts) walks orders, filters to those with
 * `payment_initiated_at` set (= Faire has actually triggered the payout),
 * and idempotently posts one per-order journal + bank sweep.
 */

const FAIRE_API_BASE = "https://www.faire.com/external-api/v2";

// ── Subset of the Faire order response that we care about ──
export interface FaireOrderApiShape {
  id: string;                   // "bo_qmth4zeruy"
  display_id: string;           // "QMTH4ZERUY"
  state: string;                // PROCESSING / IN_TRANSIT / DELIVERED / CANCELED / ...
  source?: string;              // "FAIRE_DIRECT" / null
  created_at: string;
  updated_at: string;
  ship_after?: string;
  payment_initiated_at?: string | null;
  estimated_payout_at?: string | null;
  retailer_id?: string;
  customer?: { first_name?: string; last_name?: string };
  address?: { company_name?: string; country_code?: string };
  is_free_shipping?: boolean;
  payout_costs?: {
    payout_fee?: { amount_minor: number; currency: string };
    commission?: { amount_minor: number; currency: string };
    total_payout?: { amount_minor: number; currency: string };
    subtotal_after_brand_discounts?: { amount_minor: number; currency: string };
    total_brand_discounts?: { amount_minor: number; currency: string };
  };
  shipments?: Array<{
    maker_cost_cents?: number;
    maker_cost?: { amount_minor: number; currency: string };
    shipping_type?: string;
    carrier?: string;
    tracking_code?: string;
  }>;
  items?: Array<{
    sku: string;
    quantity: number;
    price_cents?: number;
    product_name?: string;
    variant_name?: string;
  }>;
}

export interface FaireOrdersPage {
  orders: FaireOrderApiShape[];
  cursor: string | null;
}

// ── Faire API helpers ──

async function faireGet(path: string): Promise<Response> {
  const token = process.env.FAIRE_API_TOKEN;
  if (!token) throw new Error("FAIRE_API_TOKEN not configured");
  return fetch(`${FAIRE_API_BASE}${path}`, {
    headers: { "X-FAIRE-ACCESS-TOKEN": token, "Content-Type": "application/json" },
  });
}

/** Fetch one page of orders. Cursor null = first page. */
export async function listFaireOrdersPage(opts: { limit?: number; cursor?: string | null } = {}): Promise<FaireOrdersPage> {
  const limit = opts.limit ?? 50;
  const cursorParam = opts.cursor ? `&cursor=${encodeURIComponent(opts.cursor)}` : "";
  const res = await faireGet(`/orders?limit=${limit}${cursorParam}`);
  if (!res.ok) throw new Error(`Faire /orders → HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json() as { orders?: FaireOrderApiShape[]; cursor?: string | null };
  return {
    orders: data.orders ?? [],
    cursor: data.cursor ?? null,
  };
}

/** Fetch a single Faire order by id ("bo_..." or display id). */
export async function fetchFaireOrder(orderId: string): Promise<FaireOrderApiShape | null> {
  const res = await faireGet(`/orders/${orderId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Faire /orders/${orderId} → HTTP ${res.status}: ${await res.text()}`);
  return await res.json() as FaireOrderApiShape;
}

// ── Payout summary ──
//
// One Faire order = one mini-payout in our accounting model. Each gets its
// own per-order journal posted on payment_initiated_at.

export interface FairePayoutSummary {
  /** Internal Faire ID ("bo_..."). Used as the source_payout_id in
   * xero_payout_syncs so re-runs are idempotent. */
  payoutKey: string;
  /** Display ID ("QMTH4ZERUY"), matches our local orders.order_number after "#". */
  displayId: string;
  /** ISO date Faire initiated the payout to us. Used as the journal Date. */
  paymentInitiatedAt: string;
  /** Dollar amounts (USD-converted from amount_minor cents). */
  totalPayout: number;          // net to bank, e.g. 816.77
  netOrderTotal: number;        // subtotal_after_brand_discounts, e.g. 820.80
  paymentFee: number;           // payout_fee, e.g. 29.03
  commission: number;           // 0 for Faire Direct
  shippingReimbursement: number; // maker_cost from shipments[0]
  brandDiscount: number;        // total_brand_discounts (informational)
  currency: string;
  source: string;               // "FAIRE_DIRECT" / "FAIRE_MARKETPLACE"
  retailerCompany: string | null;
}

/** Parse a Faire order's payout_costs into our flat summary shape. */
export function summarizeFairePayout(order: FaireOrderApiShape): FairePayoutSummary | null {
  if (!order.payment_initiated_at || !order.payout_costs) return null;
  const cents = (m: { amount_minor: number } | undefined): number =>
    m ? m.amount_minor / 100 : 0;

  const totalPayout = cents(order.payout_costs.total_payout);
  if (totalPayout === 0) return null;

  // Shipping reimbursement: only counts when seller paid for the label
  // ("SHIP_ON_YOUR_OWN") — when Faire is shipping, maker_cost is 0.
  const shippingReimbursement = (order.shipments ?? [])
    .filter((s) => s.shipping_type !== "SHIP_BY_FAIRE")
    .reduce((sum, s) => sum + cents(s.maker_cost), 0);

  return {
    payoutKey: order.id,
    displayId: order.display_id,
    paymentInitiatedAt: order.payment_initiated_at,
    totalPayout,
    netOrderTotal: cents(order.payout_costs.subtotal_after_brand_discounts),
    paymentFee: cents(order.payout_costs.payout_fee),
    commission: cents(order.payout_costs.commission),
    shippingReimbursement,
    brandDiscount: cents(order.payout_costs.total_brand_discounts),
    currency: order.payout_costs.total_payout?.currency ?? "USD",
    source: order.source ?? "FAIRE_UNKNOWN",
    retailerCompany: order.address?.company_name ?? null,
  };
}

/**
 * Sanity-check that the breakdown adds up. Returns the delta (should be 0
 * or a tiny rounding artefact). Callers should warn — not fail — on
 * non-zero values, since Faire occasionally has float rounding noise.
 */
export function fairePayoutBalanceDelta(p: FairePayoutSummary): number {
  const expected = p.netOrderTotal - p.commission - p.paymentFee + p.shippingReimbursement;
  return Math.round((p.totalPayout - expected) * 100) / 100;
}
