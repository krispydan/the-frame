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
}) {
  await postSlack({
    topic: "ops.webhook_flood",
    text: `🌊 ${opts.service} webhook flood: ${opts.count} hits in ${opts.windowSeconds}s`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🌊 *Webhook flood from ${opts.service}*\n${opts.count} webhooks in the last ${opts.windowSeconds}s. Could be a replay or something looped — worth a quick look.`,
        },
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
