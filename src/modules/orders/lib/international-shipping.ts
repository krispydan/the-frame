/**
 * International shipping request flow.
 *
 * Non-US Faire orders require Jaxy to generate the shipping label through
 * Faire (customs/duties). Since the label needs packaged dims + weight, we
 * email the 3PL warehouse to ask for them, then create the label in Faire
 * and upload it to ShipHero.
 *
 * This module:
 *   1. Detects whether a synced order qualifies (non-US + Faire channel)
 *   2. Creates an international_shipping_requests row (idempotent per order)
 *   3. Optionally auto-sends the warehouse email (gated behind two settings)
 *
 * Two feature flags (settings table, default OFF):
 *   - intl_shipping_enabled   → master switch; when off, nothing happens
 *   - intl_shipping_auto_send → when on, the dims email fires automatically;
 *                               when off, requests queue for manual "Send"
 */
import { sqlite } from "@/lib/db";
import { sendInternationalShippingDimsEmail } from "@/lib/email";

// ── Settings helpers (string-flag convention, === "true") ──

function getSetting(key: string): string | null {
  const r = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string | null }
    | undefined;
  return r?.value ?? null;
}

export function isIntlShippingEnabled(): boolean {
  return getSetting("intl_shipping_enabled") === "true";
}

export function isIntlShippingAutoSend(): boolean {
  return getSetting("intl_shipping_auto_send") === "true";
}

/** Warehouse + notification addresses (overridable via settings). */
function getWarehouseEmail(): string {
  return getSetting("intl_shipping_warehouse_email") || "team@bigskyfulfillment.com";
}
function getCcEmail(): string {
  return getSetting("intl_shipping_cc_email") || "wholesale@getjaxy.com";
}

// ── Country / channel detection ──

/**
 * True when the country is anything other than the US. Handles the various
 * formats Shopify/Faire return: "US", "USA", "United States", "us", etc.
 * Puerto Rico and other US territories are treated as international per Jaxy's
 * rule (they ship like international for Faire label purposes).
 */
export function isNonUsCountry(country: string | null | undefined): boolean {
  if (!country) return false; // no country data → don't trigger (fail safe)
  const c = country.trim().toLowerCase();
  if (!c) return false;
  const usValues = new Set(["us", "usa", "united states", "united states of america", "u.s.", "u.s.a."]);
  return !usValues.has(c);
}

/**
 * True when the Shopify sales-channel attribution indicates the order came
 * from Faire. Shopify exposes this as order.source_name (stored on the order).
 */
export function isFaireChannel(sourceName: string | null | undefined): boolean {
  if (!sourceName) return false;
  return /faire/i.test(sourceName);
}

// ── Link builders ──

export function buildFaireOrderUrl(orderNumber: string): string {
  // Faire order numbers look like "G4JWGQ7J94". This search-style link lands
  // the internal team on the order; swap for the exact brand-token URL once
  // confirmed. Strip a leading "#" if present.
  const clean = orderNumber.replace(/^#/, "");
  return `https://www.faire.com/messages/orders/${encodeURIComponent(clean)}`;
}

export function buildShipheroOrderUrl(shipheroOrderId: string | null): string | null {
  if (!shipheroOrderId) return null;
  return `https://app.shiphero.com/dashboard/orders/detail/${encodeURIComponent(shipheroOrderId)}`;
}

// ── Core: create the request from an order ──

export interface IntlShipRequestRow {
  id: string;
  order_id: string;
  order_number: string;
  external_id: string | null;
  shiphero_order_id: string | null;
  ship_to_country: string | null;
  source_name: string | null;
  status: string;
  email_sent_at: string | null;
  resend_message_id: string | null;
  packaged_length_in: number | null;
  packaged_width_in: number | null;
  packaged_height_in: number | null;
  packaged_weight_lb: number | null;
  box_count: number | null;
  dims_received_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface OrderRow {
  id: string;
  order_number: string;
  external_id: string | null;
  shiphero_order_id: string | null;
  ship_to_country: string | null;
  source_name: string | null;
  channel: string;
}

/**
 * Check a freshly-synced order and, if it's a non-US Faire order, create an
 * international shipping request. Returns the request row if created (or the
 * existing one), or null if the order doesn't qualify / the feature is off.
 *
 * Best-effort — callers wrap this in a try/catch so it never blocks order ingest.
 */
export async function maybeCreateInternationalShippingRequest(
  orderId: string,
): Promise<IntlShipRequestRow | null> {
  if (!isIntlShippingEnabled()) return null;

  const order = sqlite.prepare(
    `SELECT id, order_number, external_id, shiphero_order_id, ship_to_country, source_name, channel
     FROM orders WHERE id = ?`,
  ).get(orderId) as OrderRow | undefined;

  if (!order) return null;

  // Gate: non-US ship-to country is the hard requirement.
  if (!isNonUsCountry(order.ship_to_country)) return null;

  // Confirmation: order should have originated from Faire. If we have no
  // source_name at all, we still proceed (country is the hard rule) but flag
  // it in notes so the dashboard shows it needs a human glance.
  const faire = isFaireChannel(order.source_name);
  const channelNote = faire
    ? null
    : `Channel not confirmed as Faire (source_name="${order.source_name ?? "none"}") — please verify before shipping.`;

  // Idempotent: one request per order.
  const existing = sqlite.prepare(
    "SELECT * FROM international_shipping_requests WHERE order_id = ?",
  ).get(orderId) as IntlShipRequestRow | undefined;
  if (existing) return existing;

  const id = crypto.randomUUID();
  sqlite.prepare(
    `INSERT INTO international_shipping_requests
       (id, order_id, order_number, external_id, shiphero_order_id, ship_to_country, source_name, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_dims', ?)`,
  ).run(
    id,
    order.id,
    order.order_number,
    order.external_id,
    order.shiphero_order_id,
    order.ship_to_country,
    order.source_name,
    channelNote,
  );

  const row = sqlite.prepare(
    "SELECT * FROM international_shipping_requests WHERE id = ?",
  ).get(id) as IntlShipRequestRow;

  // Auto-send the dims email if enabled. Otherwise it waits in the queue for
  // a manual "Send" click on the dashboard.
  if (isIntlShippingAutoSend()) {
    await sendDimsEmailForRequest(id);
  }

  return row;
}

/**
 * Send (or re-send) the warehouse dims request email for a given request,
 * and stamp email_sent_at. Returns { ok, error? }.
 */
export async function sendDimsEmailForRequest(
  requestId: string,
): Promise<{ ok: boolean; error?: string }> {
  const req = sqlite.prepare(
    "SELECT * FROM international_shipping_requests WHERE id = ?",
  ).get(requestId) as IntlShipRequestRow | undefined;
  if (!req) return { ok: false, error: "Request not found" };

  const result = await sendInternationalShippingDimsEmail({
    orderNumber: req.order_number,
    country: req.ship_to_country || "an international address",
    faireOrderUrl: buildFaireOrderUrl(req.order_number),
    shipheroOrderUrl: buildShipheroOrderUrl(req.shiphero_order_id),
    to: getWarehouseEmail(),
    cc: getCcEmail(),
    replyTo: getCcEmail(),
  });

  if (!result.ok) return { ok: false, error: result.error || "send failed" };

  const messageId = (result.data as { id?: string } | undefined)?.id ?? null;
  sqlite.prepare(
    `UPDATE international_shipping_requests
       SET email_sent_at = datetime('now'), resend_message_id = ?,
           status = CASE WHEN status = 'awaiting_dims' THEN 'awaiting_dims' ELSE status END,
           updated_at = datetime('now')
     WHERE id = ?`,
  ).run(messageId, requestId);

  return { ok: true };
}

// ── Query helpers for the dashboard ──

export function listIntlShippingRequests(status?: string): IntlShipRequestRow[] {
  if (status && status !== "all") {
    return sqlite.prepare(
      "SELECT * FROM international_shipping_requests WHERE status = ? ORDER BY created_at DESC LIMIT 200",
    ).all(status) as IntlShipRequestRow[];
  }
  return sqlite.prepare(
    "SELECT * FROM international_shipping_requests ORDER BY created_at DESC LIMIT 200",
  ).all() as IntlShipRequestRow[];
}

export function updateIntlShippingRequest(
  id: string,
  fields: Partial<{
    status: string;
    packaged_length_in: number | null;
    packaged_width_in: number | null;
    packaged_height_in: number | null;
    packaged_weight_lb: number | null;
    box_count: number | null;
    dims_received_at: string | null;
    shiphero_order_id: string | null;
    notes: string | null;
  }>,
): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => (fields as Record<string, unknown>)[k]);
  sqlite.prepare(
    `UPDATE international_shipping_requests SET ${setClause}, updated_at = datetime('now') WHERE id = ?`,
  ).run(...values, id);
}
