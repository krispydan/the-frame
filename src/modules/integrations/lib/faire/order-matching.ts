/**
 * Faire order matching for ShipHero webhooks.
 *
 * Faire-sourced orders flow into ShipHero via the Shopify channel integration
 * and arrive with an order_number equal to the Faire display_id (e.g. "#X4ECZ86SZT").
 * This module resolves that display_id back to the Faire order id ("bo_xxx")
 * required by the Faire packing-slip-pdf endpoint.
 *
 * See: docs/shiphero-webhooks-and-faire-slips.md
 */

const FAIRE_API_BASE = "https://www.faire.com/external-api/v2";
const MAX_PAGES = 6;
const LIMIT = 50;
const MAX_AGE_DAYS = 90;
const DISPLAY_ID_PATTERN = /^[A-Z0-9]{6,}$/i;

export interface FaireOrderMatch {
  /** Faire order id, e.g. "bo_abc123" — what packing-slip-pdf endpoint needs. */
  faireOrderId: string;
  /** Faire human-readable code, e.g. "X4ECZ86SZT". */
  displayId: string;
  /** Faire order state, e.g. "PROCESSING", "DELIVERED". Useful for handlers
   *  that want to verify the order is still in a shippable state. */
  state: string;
}

interface FaireOrderListItem {
  id: string;
  display_id: string;
  state: string;
}

interface FaireOrderListResponse {
  orders: FaireOrderListItem[];
}

async function faireApiFetch(path: string): Promise<Response> {
  const token = process.env.FAIRE_API_TOKEN;
  if (!token) throw new Error("FAIRE_API_TOKEN not configured");

  return fetch(`${FAIRE_API_BASE}${path}`, {
    headers: {
      "X-FAIRE-ACCESS-TOKEN": token,
      "Content-Type": "application/json",
    },
  });
}

/**
 * Find the Faire order matching a ShipHero order_number.
 *
 * ShipHero order_numbers for Faire-sourced orders look like "#X4ECZ86SZT"
 * (the Faire display_id from the Shopify channel integration). Returns null
 * if no match — i.e. the order isn't Faire-sourced (most DTC orders will
 * be null).
 *
 * @param orderNumber - the order_number / partner_order_id from the
 *   ShipHero webhook payload. Leading "#" is stripped.
 */
export async function findFaireOrderByOrderNumber(
  orderNumber: string,
): Promise<FaireOrderMatch | null> {
  // TODO: Once verified with Faire support, switch to a direct
  // `?filter=display_id&value=<code>` (or equivalent) query parameter.
  // That would make this O(1) instead of O(N) page scanning. The exact
  // query-string syntax for filtering by display_id is not yet confirmed
  // against real Faire data, so we use the bounded-paginate fallback below.

  const code = orderNumber.replace(/^#/, "").trim();
  if (!DISPLAY_ID_PATTERN.test(code)) return null;

  const updatedAtMin = new Date(
    Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const target = code.toUpperCase();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      limit: String(LIMIT),
      page: String(page),
      updated_at_min: updatedAtMin,
    });

    const res = await faireApiFetch(`/orders?${params.toString()}`);
    if (!res.ok) {
      throw new Error(
        `Faire orders list failed: ${res.status} ${res.statusText}`,
      );
    }

    const body = (await res.json()) as FaireOrderListResponse;
    const orders = body.orders ?? [];

    for (const order of orders) {
      if (order.display_id?.toUpperCase() === target) {
        return {
          faireOrderId: order.id,
          displayId: order.display_id,
          state: order.state,
        };
      }
    }

    if (orders.length < LIMIT) return null;
  }

  return null;
}
