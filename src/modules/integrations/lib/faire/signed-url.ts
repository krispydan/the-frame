/**
 * Signed URL minter for the Faire packing-slip proxy.
 *
 * The ShipHero `order_add_attachment` mutation takes a URL — ShipHero PULLS
 * the document from us rather than us POSTing the body. We can't expose the
 * Faire API token publicly, so we host a tightly-scoped proxy route that
 * re-fetches the PDF from Faire on the inbound request.
 *
 * URLs are HMAC-signed and bound to a single Faire order id. They do NOT
 * expire — the warehouse may open the attachment days or weeks after the
 * order is allocated, and a TTL that runs out before pick produces a
 * confusing "Expired" error that looks like a login wall.
 *
 * Legacy URLs (minted before 2026-06-15) included an `exp` query param and
 * signed over `${orderId}|${exp}`. The verifier still accepts those — it
 * re-signs with the same exp and just skips the expiry check — so existing
 * attachments in ShipHero start working again on deploy without a backfill.
 *
 * HMAC signed with PACKING_SLIP_SIGNING_SECRET (falls back to a derivation
 * of SHOPIFY_APP_SECRET for envs that haven't set the dedicated secret yet
 * — both are server-side only).
 *
 * See: docs/shiphero-webhooks-and-faire-slips.md
 */

import { createHmac, timingSafeEqual } from "crypto";

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

/** Current scheme: HMAC over the orderId alone. */
function sign(orderId: string): string {
  const secret = getSigningSecret();
  return createHmac("sha256", secret).update(orderId).digest("hex");
}

/**
 * Legacy scheme used before 2026-06-15: HMAC over `${orderId}|${exp}`.
 * Retained only for verification so URLs already stored as ShipHero
 * attachments keep validating.
 */
function signLegacy(orderId: string, exp: number): string {
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
}): string {
  const sig = sign(opts.faireOrderId);
  const params = new URLSearchParams({
    order: opts.faireOrderId,
    sig,
  });
  if (opts.displayId) params.set("display", opts.displayId);
  return `${opts.baseUrl.replace(/\/$/, "")}/api/v1/integrations/faire/packing-slip?${params.toString()}`;
}

function safeEqualHex(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function verifyPackingSlipUrl(opts: {
  faireOrderId: string;
  /** Legacy URLs include this. Omit for current-scheme URLs. */
  exp?: number;
  signature: string;
}): { ok: true } | { ok: false; reason: string } {
  // Current scheme.
  if (safeEqualHex(sign(opts.faireOrderId), opts.signature)) return { ok: true };

  // Legacy scheme — verify with the exp the URL was originally signed with.
  // Expiry is intentionally NOT checked: the whole point of Option A is that
  // ShipHero attachments need to keep working long past any TTL we'd pick.
  if (opts.exp !== undefined && Number.isFinite(opts.exp)) {
    if (safeEqualHex(signLegacy(opts.faireOrderId, opts.exp), opts.signature)) {
      return { ok: true };
    }
  }

  return { ok: false, reason: "Signature mismatch" };
}
