/**
 * Mark a Faire order as shipped via Faire's external API v2.
 *
 * Endpoint: POST /external-api/v2/orders/{order_id}/shipments
 * Auth:     X-FAIRE-ACCESS-TOKEN
 * Body:     { shipments: [{ order_id, maker_cost_cents, carrier, tracking_code }] }
 *
 * `maker_cost_cents` is the postage WE paid for shipping the order — Faire
 * uses it to reconcile our shipping reimbursement. Computed from the order
 * total via configurable tiers in settings (see ./postage-tiers.ts).
 *
 * Behavior at Faire's side per their docs: the shipment first goes to
 * PRE_TRANSIT, then to IN_TRANSIT once the carrier scans the label.
 *
 * See: docs/shiphero-webhooks-and-faire-slips.md
 */

const FAIRE_API_BASE = "https://www.faire.com/external-api/v2";

/** Faire's accepted carrier enum (from their developer docs). */
export type FaireCarrier =
  | "USPS"
  | "UPS"
  | "FEDEX"
  | "DHL_ECOMMERCE"
  | "DHL_EXPRESS"
  | "POSTNL"
  | "CANADA_POST"
  | "PUROLATOR"
  | "CANPAR";

const CARRIER_ALIASES: Record<string, FaireCarrier> = {
  // USPS
  usps: "USPS",
  "u.s. postal service": "USPS",
  "united states postal service": "USPS",
  // UPS
  ups: "UPS",
  "united parcel service": "UPS",
  // FedEx
  fedex: "FEDEX",
  "fedex ground": "FEDEX",
  "fedex express": "FEDEX",
  "fedex home delivery": "FEDEX",
  "fedex smartpost": "FEDEX",
  // DHL
  dhl: "DHL_ECOMMERCE",
  "dhl ecommerce": "DHL_ECOMMERCE",
  "dhl global mail": "DHL_ECOMMERCE",
  "dhl express": "DHL_EXPRESS",
  // Canadian carriers
  canpar: "CANPAR",
  purolator: "PUROLATOR",
  canada_post: "CANADA_POST",
  "canada post": "CANADA_POST",
  canadapost: "CANADA_POST",
  // Dutch
  postnl: "POSTNL",
};

/**
 * Map a ShipHero/Shopify carrier string to Faire's enum. Returns null if
 * unknown — caller should then fall back to a Slack alert for manual
 * handling rather than guess.
 */
export function normalizeCarrierForFaire(raw: string | null | undefined): FaireCarrier | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if (key in CARRIER_ALIASES) return CARRIER_ALIASES[key];
  // Last-ditch fuzzy match on the more distinctive carriers.
  if (key.includes("usps")) return "USPS";
  if (key.includes("fedex")) return "FEDEX";
  if (key.startsWith("ups") || key.endsWith(" ups")) return "UPS";
  if (key.includes("dhl express")) return "DHL_EXPRESS";
  if (key.includes("dhl")) return "DHL_ECOMMERCE";
  if (key.includes("canada post")) return "CANADA_POST";
  return null;
}

function getFaireToken(): string {
  const token = process.env.FAIRE_API_TOKEN;
  if (!token) throw new Error("FAIRE_API_TOKEN not configured");
  return token;
}

export interface MarkFaireShippedInput {
  /** Faire order id, e.g. "bo_abc123". */
  faireOrderId: string;
  /** Tracking number from the carrier. */
  trackingCode: string;
  /** Faire carrier enum — call normalizeCarrierForFaire() first. */
  carrier: FaireCarrier;
  /** Postage WE paid for shipping (whole dollars × 100). */
  makerCostCents: number;
}

export interface MarkFaireShippedResult {
  ok: boolean;
  status: number;
  /** Body text or parsed JSON, kept untyped because Faire's docs don't
   *  specify the success shape. */
  body: unknown;
}

/**
 * POST a shipment to Faire. Wraps the response so callers can log + audit
 * without re-throwing. Does NOT retry — the caller decides (idempotency is
 * managed externally via the local order.shippedAt transition gate).
 */
export async function markFaireOrderShipped(
  input: MarkFaireShippedInput,
): Promise<MarkFaireShippedResult> {
  const token = getFaireToken();

  const payload = {
    shipments: [
      {
        order_id: input.faireOrderId,
        maker_cost_cents: input.makerCostCents,
        carrier: input.carrier,
        tracking_code: input.trackingCode,
      },
    ],
  };

  const res = await fetch(`${FAIRE_API_BASE}/orders/${input.faireOrderId}/shipments`, {
    method: "POST",
    headers: {
      "X-FAIRE-ACCESS-TOKEN": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  let body: unknown;
  const contentType = res.headers.get("content-type") || "";
  try {
    if (contentType.includes("application/json")) {
      body = await res.json();
    } else {
      body = await res.text();
    }
  } catch {
    body = null;
  }

  return { ok: res.ok, status: res.status, body };
}
