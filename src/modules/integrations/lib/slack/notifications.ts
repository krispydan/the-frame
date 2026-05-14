/**
 * Friendly Slack notification helpers.
 *
 * Each function takes a domain object and posts a Block Kit message via
 * postSlack. Tone: warm, lightly playful, emoji-friendly. Don't sound like
 * a corporate alerting system.
 *
 * Every helper is fire-and-forget — they swallow errors so they never
 * break the upstream operation (an order webhook should still complete
 * even if Slack delivery fails).
 */

import { postSlack, type SlackBlock } from "./client";

/* ── Formatters ── */

function money(amount: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

function pluralize(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "just now";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} hr ago`;
  return `${Math.round(ms / 86_400_000)} days ago`;
}

/**
 * Build a Faire brand-portal URL from a Shopify order name, IFF the order
 * looks like it originated from Faire.
 *
 * Faire syncs orders into Shopify using the Faire booking ID as the order
 * name — always 10 chars, alphanumeric, uppercase (e.g. "#CV78JYQU29"). The
 * matching Faire portal URL uses the same ID lowercased and prefixed `bo_`:
 *   #CV78JYQU29 → https://www.faire.com/brand-portal/orders/bo_cv78jyqu29/order-fulfilment
 *
 * Returns null for any order that doesn't match the Faire ID pattern.
 */
export function faireOrderUrlFromName(orderName: string | null | undefined): string | null {
  if (!orderName) return null;
  const m = /^#?([A-Z0-9]{10})$/.exec(orderName.trim());
  if (!m) return null;
  return `https://www.faire.com/brand-portal/orders/bo_${m[1].toLowerCase()}/order-fulfilment`;
}

/**
 * Build the Shopify admin order URL.
 *   getjaxy.myshopify.com + 6959466381461 → https://admin.shopify.com/store/getjaxy/orders/6959466381461
 * Returns null if we can't form a clean URL.
 */
export function shopifyAdminOrderUrl(shopDomain: string | null | undefined, externalOrderId: string | null | undefined): string | null {
  if (!shopDomain || !externalOrderId) return null;
  const handle = shopDomain.replace(/\.myshopify\.com$/i, "").replace(/^https?:\/\//, "");
  return `https://admin.shopify.com/store/${handle}/orders/${externalOrderId}`;
}

/* ── Wholesale order ── */

export async function notifyWholesaleOrder(opts: {
  orderNumber: string;
  channel: string;
  total: number;
  currency: string;
  itemCount: number;
  companyName: string | null;
  shopUrl?: string | null;
  /** Top SKUs for the line preview. */
  topSkus?: Array<{ sku: string; name: string; qty: number }>;
}) {
  const channelLabel = opts.channel === "shopify_wholesale" ? "Shopify Wholesale" : opts.channel === "faire" ? "Faire" : opts.channel;
  const customer = opts.companyName ? `*${opts.companyName}*` : "A new account";
  const total = money(opts.total, opts.currency);

  const skuLine = opts.topSkus && opts.topSkus.length > 0
    ? opts.topSkus.map((s) => `• \`${s.sku}\` ${s.name} × ${s.qty}`).join("\n")
    : null;

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🛍️ *New wholesale order* — ${customer} just dropped *${total}* on ${pluralize(opts.itemCount, "frame", "frames")} 🎉`,
      },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Order *${opts.orderNumber}* · ${channelLabel}${opts.shopUrl ? ` · <${opts.shopUrl}|view in Shopify>` : ""}` },
      ],
    },
  ];
  if (skuLine) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: skuLine } });
  }

  await postSlack({
    topic: "orders.wholesale",
    text: `🛍️ New wholesale order ${opts.orderNumber} from ${opts.companyName || "a new account"} — ${total}`,
    blocks,
  });
}

/* ── Order fulfilled (shipped) ── */

export async function notifyOrderFulfilled(opts: {
  orderNumber: string;
  channel: string;
  total: number;
  currency: string;
  itemCount: number;
  companyName: string | null;
  trackingNumber: string | null;
  trackingCarrier: string | null;
  trackingUrl?: string | null;
  shopifyAdminUrl?: string | null;
  /** Faire brand-portal URL — only set for Faire-originated orders. */
  faireUrl?: string | null;
  /** Top SKUs in the fulfillment for context. */
  topSkus?: Array<{ sku: string; name: string; qty: number }>;
}) {
  const channelLabel =
    opts.channel === "shopify_dtc" ? "Retail"
    : opts.channel === "shopify_wholesale" ? (opts.faireUrl ? "Faire (via Wholesale)" : "Wholesale")
    : opts.channel === "faire" ? "Faire"
    : opts.channel;
  const customer = opts.companyName ? `*${opts.companyName}*` : "the customer";
  const total = money(opts.total, opts.currency);

  // First line — the lead sentence.
  const intro = `📦 *Order fulfilled* — ${customer}'s order is on the way (${total}, ${pluralize(opts.itemCount, "frame", "frames")})`;

  // Tracking sub-line. Carrier name + number; link out if we have a URL.
  const trackingLine = (() => {
    if (!opts.trackingNumber) return null;
    const carrier = opts.trackingCarrier ? `${opts.trackingCarrier} ` : "";
    const num = opts.trackingUrl
      ? `<${opts.trackingUrl}|${opts.trackingNumber}>`
      : `\`${opts.trackingNumber}\``;
    return `🚚 ${carrier}${num}`;
  })();

  // Context line: order #, channel, plus deep links.
  const links: string[] = [];
  if (opts.shopifyAdminUrl) links.push(`<${opts.shopifyAdminUrl}|Shopify>`);
  if (opts.faireUrl) links.push(`<${opts.faireUrl}|Faire>`);
  const contextLine = `Order *${opts.orderNumber}* · ${channelLabel}${links.length ? ` · ${links.join(" · ")}` : ""}`;

  const skuLine = opts.topSkus && opts.topSkus.length > 0
    ? opts.topSkus.map((s) => `• \`${s.sku}\` ${s.name} × ${s.qty}`).join("\n")
    : null;

  const blocks: SlackBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: intro } },
  ];
  if (trackingLine) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: trackingLine } });
  }
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: contextLine }],
  });
  if (skuLine) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: skuLine } });
  }

  await postSlack({
    topic: "orders.fulfilled",
    text: `📦 Order ${opts.orderNumber} fulfilled${opts.trackingNumber ? ` — ${opts.trackingNumber}` : ""}`,
    blocks,
  });
}

/* ── Stock alerts ── */

export async function notifyOutOfStock(opts: {
  sku: string;
  productName: string;
  colorName: string | null;
}) {
  const product = `${opts.productName}${opts.colorName ? ` (${opts.colorName})` : ""}`;
  await postSlack({
    topic: "stock.out_of_stock",
    text: `🚨 OUT OF STOCK: ${opts.sku} ${product}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🚨 *Out of stock alert*\n\`${opts.sku}\` *${product}* just hit zero. Customers can't buy it until we restock.`,
        },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Time to check the next PO 📦` }],
      },
    ],
  });
}

export async function notifyCriticalLowStock(opts: {
  sku: string;
  productName: string;
  colorName: string | null;
  quantity: number;
  reorderPoint: number;
}) {
  const product = `${opts.productName}${opts.colorName ? ` (${opts.colorName})` : ""}`;
  await postSlack({
    topic: "stock.critical_low",
    text: `⚠️ Critical low stock: ${opts.sku} ${product} (${opts.quantity} left)`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `⚠️ *Critical low stock*\n\`${opts.sku}\` *${product}* — only *${opts.quantity}* left (reorder point ${opts.reorderPoint}).`,
        },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `🏃‍♂️ Reorder window is now.` }],
      },
    ],
  });
}

/* ── Payment / chargeback ── */

export async function notifyPaymentFailed(opts: {
  orderNumber: string;
  channel: string;
  total: number;
  currency: string;
  customerEmail: string | null;
  reason: string | null;
}) {
  await postSlack({
    topic: "orders.payment_failed",
    text: `💳 Payment failed on order ${opts.orderNumber}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `💳 *Payment didn't go through*\nOrder *${opts.orderNumber}* (${money(opts.total, opts.currency)}) · ${opts.customerEmail || "no email"}\n${opts.reason ? `Reason: _${opts.reason}_` : ""}`,
        },
      },
    ],
  });
}

export async function notifyChargeback(opts: {
  orderNumber: string;
  channel: string;
  total: number;
  currency: string;
  customerEmail: string | null;
  reason: string | null;
}) {
  await postSlack({
    topic: "orders.chargeback",
    text: `🚩 Chargeback on order ${opts.orderNumber}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🚩 *Chargeback opened*\nOrder *${opts.orderNumber}* (${money(opts.total, opts.currency)}) — ${opts.customerEmail || "unknown customer"} disputed the charge.\n${opts.reason ? `Bank says: _${opts.reason}_` : ""}`,
        },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `🛡️ Respond in Shopify before the deadline.` }],
      },
    ],
  });
}

/* ── Integration health ── */

export async function notifyIntegrationFailure(opts: {
  service: string;
  detail: string;
  fixUrl?: string;
}) {
  await postSlack({
    topic: "ops.integration_failure",
    text: `🔌 ${opts.service} integration broke: ${opts.detail}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🔌 *${opts.service} integration broke*\n${opts.detail}`,
        },
      },
      ...(opts.fixUrl
        ? ([{
            type: "context",
            elements: [{ type: "mrkdwn", text: `Fix it: <${opts.fixUrl}|open settings>` }],
          }] as SlackBlock[])
        : []),
    ],
  });
}

export async function notifyConnectedStore(opts: {
  service: string;        // "Shopify" / "Xero" / "Slack"
  identifier: string;     // shop_domain or tenantName or workspace
}) {
  await postSlack({
    topic: "ops.connected_store",
    text: `🔗 New ${opts.service} connection: ${opts.identifier}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🔗 *New ${opts.service} connection*\n*${opts.identifier}* just got wired up. Welcome aboard 👋`,
        },
      },
    ],
  });
}

export async function notifyWebhookFlood(opts: {
  service: string;
  count: number;
  windowSeconds: number;
  /** Breakdown of `${topic} (${shop})` → count for the same window. */
  breakdown?: Array<{ topic: string; shopDomain: string | null; count: number }>;
  /** Whether all events in the window had handler_ok=1. */
  allHandlerOk?: boolean;
}) {
  const lines: string[] = [
    `🌊 *Webhook flood from ${opts.service}*`,
    `${opts.count} webhooks in the last ${opts.windowSeconds}s.`,
  ];

  if (opts.breakdown && opts.breakdown.length > 0) {
    const top = opts.breakdown.slice(0, 6);
    lines.push("", "*Top topics in this window:*");
    for (const b of top) {
      lines.push(`• \`${b.topic}\` × ${b.count}${b.shopDomain ? ` _(${b.shopDomain.replace(/\.myshopify\.com$/, "")})_` : ""}`);
    }
    if (opts.breakdown.length > top.length) {
      const rest = opts.breakdown.slice(top.length).reduce((s, b) => s + b.count, 0);
      lines.push(`• _… ${opts.breakdown.length - top.length} more topics, ${rest} events_`);
    }
  }

  if (opts.allHandlerOk === true) {
    lines.push("", "✅ All events processed successfully — likely a Shopify retry queue draining (e.g., after we fixed a delivery URL). Should taper within a few minutes; no action needed.");
  } else if (opts.allHandlerOk === false) {
    lines.push("", "⚠️ Some events are failing — check `shopify_webhook_events` for handler errors.");
  }

  await postSlack({
    topic: "ops.webhook_flood",
    text: `🌊 ${opts.service} webhook flood: ${opts.count} hits in ${opts.windowSeconds}s`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n") },
      },
    ],
  });
}

/* ── Stuck order ── */

export async function notifyStuckOrder(opts: {
  orderNumber: string;
  channel: string;
  total: number;
  currency: string;
  placedAt: string;
}) {
  await postSlack({
    topic: "orders.stuck",
    text: `📦 Order ${opts.orderNumber} stuck >48h`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `📦 *Order ${opts.orderNumber}* has been chilling in *confirmed* for *${relativeTime(opts.placedAt)}*. Time to ship?\nValue: ${money(opts.total, opts.currency)}`,
        },
      },
    ],
  });
}

/* ── Finance ── */

export async function notifyPayoutReceived(opts: {
  payoutId: number;
  platform: string;
  amount: number;
  currency: string;
  date: string;
  manualJournalId: string;
  reconciliationDelta: number;
}) {
  const platformLabel = humanPlatform(opts.platform);
  const reconNote = opts.reconciliationDelta !== 0
    ? `\n\n⚠️ Reconciliation delta of ${money(opts.reconciliationDelta, opts.currency)} — review in Xero.`
    : "";
  await postSlack({
    topic: "finance.payout_received",
    text: `💸 ${platformLabel} payout #${opts.payoutId} synced: ${money(opts.amount, opts.currency)}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `💸 *${platformLabel} payout synced*\nPayout #${opts.payoutId} · ${opts.date}\nNet: *${money(opts.amount, opts.currency)}*${reconNote}`,
        },
      },
      { type: "context", elements: [{ type: "mrkdwn", text: `Xero journal ID: \`${opts.manualJournalId}\`` }] },
    ],
  });
}

export async function notifyCogsPosted(opts: {
  payoutId: number;
  platform: string;
  totalCost: number;
  currency: string;
  totalUnits: number;
  skuCount: number;
  manualJournalId: string;
}) {
  const platformLabel = humanPlatform(opts.platform);
  await postSlack({
    topic: "finance.cogs_posted",
    text: `📚 COGS journal posted: ${money(opts.totalCost, opts.currency)} for ${platformLabel} payout #${opts.payoutId}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `📚 *COGS journal posted*\n${platformLabel} payout #${opts.payoutId}\n${pluralize(opts.totalUnits, "unit", "units")} across ${pluralize(opts.skuCount, "SKU", "SKUs")} · *${money(opts.totalCost, opts.currency)}*`,
        },
      },
      { type: "context", elements: [{ type: "mrkdwn", text: `Xero journal ID: \`${opts.manualJournalId}\`` }] },
    ],
  });
}

export async function notifyXeroSyncFailed(opts: {
  payoutId: number | null;
  platform: string | null;
  errorMessage: string;
  fixUrl?: string;
}) {
  const platformLabel = opts.platform ? humanPlatform(opts.platform) : "Xero";
  await postSlack({
    topic: "finance.xero_sync_failed",
    text: `❌ Xero sync failed for ${platformLabel} payout ${opts.payoutId ?? ""}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `❌ *Xero sync failed*\n${platformLabel}${opts.payoutId ? ` payout #${opts.payoutId}` : ""}\n_${opts.errorMessage}_`,
        },
      },
      ...(opts.fixUrl
        ? ([{ type: "context", elements: [{ type: "mrkdwn", text: `<${opts.fixUrl}|Open integrations>` }] }] as SlackBlock[])
        : []),
    ],
  });
}

function humanPlatform(platform: string): string {
  switch (platform) {
    case "shopify_dtc":       return "Shopify Retail";
    case "shopify_afterpay":  return "Shopify Afterpay";
    case "shopify_wholesale": return "Shopify Wholesale";
    case "faire":             return "Faire";
    case "amazon":            return "Amazon";
    case "tiktok_shop":       return "TikTok Shop";
    default:                  return platform;
  }
}
