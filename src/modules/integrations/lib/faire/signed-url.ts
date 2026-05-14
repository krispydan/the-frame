/**
 * Signed URL minter for the Faire packing-slip proxy.
 *
 * The ShipHero `order_add_attachment` mutation takes a URL — ShipHero PULLS
 * the document from us rather than us POSTing the body. We can't expose the
 * Faire API token publicly, so we host a tightly-scoped proxy route that
 * re-fetches the PDF from Faire on the inbound request.
 *
 * Each URL is bound to a single Faire order id and expires after a short
 * window (default 24h). HMAC signed with PACKING_SLIP_SIGNING_SECRET (falls
 * back to a derivation of SHOPIFY_APP_SECRET for envs that haven't set the
 * dedicated secret yet — both are server-side only).
 *
 * See: docs/shiphero-webhooks-and-faire-slips.md
 */

import { createHmac, timingSafeEqual } from "crypto";

const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24h

function getSigningSecret(): string {
  const explicit = process.env.PACKING_SLIP_SIGNING_SECRET;
  if (explicit) return explicit;
  // Fallback derivation so the integration works without an extra env var.
  // We still namespace the derived secret so a leak of the Shopify secret
  // wouldn't directly grant access to the proxy.
  const base =
    process.env.SHOPIFY_APP_SECRET ||
    process.env.SHIPHERO_ACCESS_TOKEN ||
    process.env.FAIRE_API_TOKEN;
  if (!base) {
    throw new Error(
      "PACKING_SLIP_SIGNING_SECRET (or fallback) not configured",
    );
  }
  return createHmac("sha256", base).update("faire-packing-slip-v1").digest("hex");
}

function sign(orderId: string, exp: number): string {
  const secret = getSigningSecret();
  return createHmac("sha256", secret)
    .update(`${orderId}|${exp}`)
    .digest("hex");
}

export function mintPackingSlipUrl(opts: {
  /** Faire order id, e.g. "bo_abc123". */
  faireOrderId: string;
  /** Public base URL of this app (e.g. https://theframe.getjaxy.com). */
  baseUrl: string;
  /** Optional display id used to build a nicer filename. */
  displayId?: string;
  /** Override the default 24h TTL. */
  ttlSeconds?: number;
}): string {
  const exp = Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const sig = sign(opts.faireOrderId, exp);
  const params = new URLSearchParams({
    order: opts.faireOrderId,
    exp: String(exp),
    sig,
  });
  if (opts.displayId) params.set("display", opts.displayId);
  return `${opts.baseUrl.replace(/\/$/, "")}/api/v1/integrations/faire/packing-slip?${params.toString()}`;
}

export function verifyPackingSlipUrl(opts: {
  faireOrderId: string;
  exp: number;
  signature: string;
}): { ok: true } | { ok: false; reason: string } {
  if (!Number.isFinite(opts.exp)) return { ok: false, reason: "Invalid exp" };
  if (Math.floor(Date.now() / 1000) > opts.exp) {
    return { ok: false, reason: "Expired" };
  }
  const expected = sign(opts.faireOrderId, opts.exp);
  const a = Buffer.from(expected);
  const b = Buffer.from(opts.signature);
  if (a.length !== b.length) return { ok: false, reason: "Signature mismatch" };
  try {
    if (timingSafeEqual(a, b)) return { ok: true };
    return { ok: false, reason: "Signature mismatch" };
  } catch {
    return { ok: false, reason: "Signature mismatch" };
  }
}
