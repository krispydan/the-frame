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
import type { LeadTouchpoints, LeadPipedrive } from "@/lib/email";

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
}) {
  // Channel becomes the *headline* descriptor so the team can tell at a
  // glance which side of the business this came from. Faire-via-Wholesale
  // is its own label because it changes who needs to act (you don't reply
  // to a Faire customer in Shopify).
  const channelLabel =
    opts.channel === "shopify_dtc" ? "Retail"
    : opts.channel === "shopify_wholesale" ? (opts.faireUrl ? "Faire" : "Wholesale")
    : opts.channel === "faire" ? "Faire"
    : opts.channel;
  const customer = opts.companyName ? `*${opts.companyName}*` : "the customer";
  const total = money(opts.total, opts.currency);

  // Lead line — channel up front so it's the first thing you see.
  const intro = `📦 *${channelLabel} order fulfilled* — ${customer}'s order is on the way (${total}, ${pluralize(opts.itemCount, "frame", "frames")})`;

  // Tracking sub-line. Carrier name + number; link out if we have a URL.
  const trackingLine = (() => {
    if (!opts.trackingNumber) return null;
    const carrier = opts.trackingCarrier ? `${opts.trackingCarrier} ` : "";
    const num = opts.trackingUrl
      ? `<${opts.trackingUrl}|${opts.trackingNumber}>`
      : `\`${opts.trackingNumber}\``;
    return `🚚 ${carrier}${num}`;
  })();

  // Context line: just the order # + the deep links. Channel is in the
  // lead line above so we don't repeat ourselves here.
  const links: string[] = [];
  if (opts.shopifyAdminUrl) links.push(`<${opts.shopifyAdminUrl}|Shopify>`);
  if (opts.faireUrl) links.push(`<${opts.faireUrl}|Faire>`);
  const contextLine = `Order *${opts.orderNumber}*${links.length ? ` · ${links.join(" · ")}` : ""}`;

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

  await postSlack({
    topic: "orders.fulfilled",
    text: `📦 Order ${opts.orderNumber} fulfilled${opts.trackingNumber ? ` — ${opts.trackingNumber}` : ""}`,
    blocks,
  });
}

/* ── Faire non-US — manual ship-mark required ── */

export async function notifyFaireManualShipRequired(opts: {
  orderNumber: string;
  faireDisplayId: string;
  countryCode: string | null;
  trackingNumber: string | null;
  trackingCarrier: string | null;
  /** Faire brand-portal URL for the order. */
  faireUrl?: string | null;
}) {
  const country = opts.countryCode || "non-US";
  const tracking = opts.trackingNumber
    ? ` (${opts.trackingCarrier ? `${opts.trackingCarrier} ` : ""}\`${opts.trackingNumber}\`)`
    : "";
  const link = opts.faireUrl ? ` · <${opts.faireUrl}|open in Faire>` : "";
  const intro = `🛫 *Faire ${country} order needs manual ship-mark* — ${opts.orderNumber} just shipped${tracking}. We auto-mark US orders via Faire's API, but ${country} orders need someone to mark this one shipped in the Faire brand portal.${link}`;

  await postSlack({
    topic: "orders.faire_manual_ship_required",
    text: `🛫 Mark ${opts.orderNumber} shipped manually in Faire (${country})`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: intro } },
    ],
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

/**
 * A Faire order arrived from an anonymized Shopify customer (relay email, no
 * real website). Nudge the team to map it to a real email/website on the
 * prospect page.
 */
export async function notifyFaireMappingNeeded(opts: {
  companyName: string | null;
  orderNumber?: string | null;
  prospectUrl?: string | null;
}) {
  const who = opts.companyName ? `*${opts.companyName}*` : "A Faire customer";
  await postSlack({
    topic: "orders.wholesale",
    text: `🕵️ ${opts.companyName || "A Faire customer"} needs a real email/website mapped`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🕵️ ${who} ordered via Faire with an anonymized email${opts.orderNumber ? ` (order *${opts.orderNumber}*)` : ""}. Add their real website + email so we can reach them and sync to Pipedrive.`,
        },
      },
      ...(opts.prospectUrl
        ? ([{
            type: "context",
            elements: [{ type: "mrkdwn", text: `Map it: <${opts.prospectUrl}|open the prospect>` }],
          }] as SlackBlock[])
        : []),
    ],
  });
}

/**
 * A worked prospect just placed their first wholesale order — celebrate the
 * conversion. Mirrors the Overjoy "you converted a lead" alert.
 */
export async function notifyLeadConverted(opts: {
  companyName: string | null;
  prospectUrl?: string | null;
  contactEmail?: string | null;
  firstContactAt?: string | null;
  orderTotal: number;
  currency: string;
  channel: string;
  isFirstOrder: boolean;
  duplicate?: { name: string; url?: string | null } | null;
  touchpoints?: LeadTouchpoints | null;
  pipedrive?: LeadPipedrive | null;
}) {
  const who = opts.companyName || "A prospect";
  const total = money(opts.orderTotal, opts.currency);
  const lines: string[] = [];
  if (opts.firstContactAt) lines.push(`First contacted: ${new Date(opts.firstContactAt).toLocaleDateString()}`);
  if (opts.contactEmail) lines.push(`Contact: ${opts.contactEmail}`);
  lines.push(`${opts.isFirstOrder ? "Opening order" : "Order"}: ${total}`);
  if (opts.prospectUrl) lines.push(`<${opts.prospectUrl}|Open in the frame>`);

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🎉 *Lead converted!* *${who}* just placed ${opts.isFirstOrder ? "their first" : "a"} wholesale order — ${total} 🥳`,
      },
    },
    { type: "context", elements: [{ type: "mrkdwn", text: lines.join("  ·  ") }] },
  ];

  // Pipedrive deal + org links, when synced.
  if (opts.pipedrive && (opts.pipedrive.dealUrl || opts.pipedrive.orgUrl)) {
    const pd = opts.pipedrive;
    const parts: string[] = [];
    if (pd.dealUrl) parts.push(`<${pd.dealUrl}|View deal${pd.dealStatus ? ` (${pd.dealStatus})` : ""}>`);
    if (pd.orgUrl) parts.push(`<${pd.orgUrl}|View organization>`);
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `🟢 Pipedrive: ${parts.join("  ·  ")}` }] });
  }

  // "How we won them" — campaigns + touchpoints that drove the order.
  if (opts.touchpoints && (opts.touchpoints.campaigns.length || opts.touchpoints.calls.length)) {
    const t = opts.touchpoints.totals;
    const summary = [
      `${t.campaigns} campaign${t.campaigns === 1 ? "" : "s"}`,
      t.emailsSent ? `${t.emailsSent} email${t.emailsSent === 1 ? "" : "s"} sent` : "",
      t.opens ? `${t.opens} open${t.opens === 1 ? "" : "s"}` : "",
      t.replies ? `${t.replies} repl${t.replies === 1 ? "y" : "ies"}` : "",
      t.calls ? `${t.calls} call${t.calls === 1 ? "" : "s"}${t.connectedCalls ? ` (${t.connectedCalls} connected)` : ""}` : "",
    ]
      .filter(Boolean)
      .join("  ·  ");
    const MAX = 8;
    const campLines = opts.touchpoints.campaigns.slice(0, MAX).map((c) => {
      const bits: string[] = [];
      if (c.openedAt) bits.push("opened");
      if (c.repliedAt) bits.push(`replied${c.replyClassification ? ` (${c.replyClassification})` : ""}`);
      if (c.callCount) bits.push(`${c.callCount} call${c.callCount === 1 ? "" : "s"}${c.lastCallDisposition ? `, last: ${c.lastCallDisposition}` : ""}`);
      return `• *${c.name}*${c.channelLabel ? ` _${c.channelLabel}_` : ""}${bits.length ? ` — ${bits.join(", ")}` : ""}`;
    });
    if (opts.touchpoints.campaigns.length > MAX) campLines.push(`_…and ${opts.touchpoints.campaigns.length - MAX} more_`);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*How we won them*\n${summary}${campLines.length ? `\n${campLines.join("\n")}` : ""}` },
    });
  }

  if (opts.duplicate) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `🔗 Looks like the same store as existing prospect *${opts.duplicate.name}*${opts.duplicate.url ? ` — <${opts.duplicate.url}|review & merge>` : ""}`,
        },
      ],
    });
  }
  if (/faire/i.test(opts.channel)) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "⚠️ Ordered on Faire — make sure you don't pay commission!" }],
    });
  }

  await postSlack({
    topic: "orders.wholesale",
    text: `🎉 Lead converted: ${who} placed a wholesale order (${total})`,
    blocks,
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

export async function notifyCogsDailySummary(opts: {
  date: string;
  units: number;
  totalCogs: number;
  currency: string;
  ordersProcessed: number;
  exceptionsOpen: number;
  manualJournalId: string | null;
}) {
  const exLine = opts.exceptionsOpen > 0
    ? `\n⚠️ *${pluralize(opts.exceptionsOpen, "exception", "exceptions")}* need attention`
    : "";
  await postSlack({
    topic: "finance.cogs_daily_summary",
    text: `📦 Daily COGS ${opts.date}: ${money(opts.totalCogs, opts.currency)} (${opts.units} units)`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `📦 *Daily COGS posted — ${opts.date}*\n${pluralize(opts.units, "unit", "units")} across ${pluralize(opts.ordersProcessed, "order", "orders")} · *${money(opts.totalCogs, opts.currency)}*${exLine}`,
        },
      },
      ...(opts.manualJournalId
        ? ([{ type: "context", elements: [{ type: "mrkdwn", text: `Xero journal ID: \`${opts.manualJournalId}\`` }] }] as SlackBlock[])
        : []),
    ],
  });
}

export async function notifyFaireIssueCredit(opts: {
  displayId: string;
  retailer: string | null;
  originalPayout: number;
  currentPayout: number;
  delta: number; // negative = Faire reduced the payout
  currency: string;
}) {
  const dir = opts.delta < 0 ? "reduced" : "increased";
  await postSlack({
    topic: "finance.faire_issue_credit",
    text: `🟠 Faire issue credit — order ${opts.displayId}: payout ${dir} by ${Math.abs(opts.delta).toFixed(2)}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `🟠 *Faire issue credit detected — order ${opts.displayId}*${opts.retailer ? ` (${opts.retailer})` : ""}\n` +
            `Faire retroactively ${dir} this already-synced payout: ${opts.currency} ${opts.originalPayout.toFixed(2)} → ${opts.currentPayout.toFixed(2)} (Δ ${opts.delta.toFixed(2)}).\n` +
            `Usually an under-shipment / damaged / missing issue report. *Expect a matching bank ${opts.delta < 0 ? "debit" : "credit"} of ${Math.abs(opts.delta).toFixed(2)} on Mercury* — since our synced entry kept the original amount, code it as *Spend Money → 5900 Inventory Adjustments & Shrinkage* (contact: Faire, reference the order #). See SOP §4b.`,
        },
      },
    ],
  });
}

export async function notifyCogsRunFailed(opts: { date: string; errorMessage: string }) {
  await postSlack({
    topic: "finance.cogs_run_failed",
    text: `❌ Daily COGS run failed for ${opts.date}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `❌ *Daily COGS run failed — ${opts.date}*\n_${opts.errorMessage}_` },
      },
    ],
  });
}

export async function notifyCogsException(opts: {
  type: "shortfall" | "zero_cost" | "implausible_cost" | "unmapped_sku";
  count: number;
  date: string;
  examples: string[]; // e.g. "#1042 JX1001-BLK ×12"
  orderUrl?: string;
}) {
  const label: Record<string, string> = {
    shortfall: "No inventory cost layer (shortfall)",
    zero_cost: "Zero / implausible cost",
    implausible_cost: "Implausible cost",
    unmapped_sku: "Unmapped SKU",
  };
  const emoji = opts.type === "zero_cost" || opts.type === "implausible_cost" ? "🔴" : "🟠";
  await postSlack({
    topic: "finance.cogs_exception",
    text: `${emoji} COGS ${label[opts.type]}: ${opts.count} on ${opts.date}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} *COGS exception — ${label[opts.type]}*\n${pluralize(opts.count, "order line", "order lines")} on ${opts.date} couldn't be costed and were excluded from the journal until fixed.\n${opts.examples.slice(0, 8).map((e) => `• ${e}`).join("\n")}`,
        },
      },
      ...(opts.orderUrl
        ? ([{ type: "context", elements: [{ type: "mrkdwn", text: `<${opts.orderUrl}|Review in The Frame>` }] }] as SlackBlock[])
        : []),
    ],
  });
}

export async function notifyCogsCorrected(opts: {
  date: string;
  reason: string;
  reversedJournalId: string | null;
  newJournalId: string | null;
  newTotal: number;
  currency: string;
  postedInPeriodNote?: string;
}) {
  await postSlack({
    topic: "finance.cogs_corrected",
    text: `♻️ COGS corrected for ${opts.date}: ${money(opts.newTotal, opts.currency)}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `♻️ *COGS corrected — ${opts.date}*\n${opts.reason}\nNew total: *${money(opts.newTotal, opts.currency)}*${opts.postedInPeriodNote ? `\n_${opts.postedInPeriodNote}_` : ""}`,
        },
      },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `Reversed: \`${opts.reversedJournalId ?? "—"}\` · New: \`${opts.newJournalId ?? "—"}\``,
        }],
      },
    ],
  });
}

export async function notifyShopifyCostPushFailed(opts: {
  sku: string;
  store: string;
  errorMessage: string;
}) {
  await postSlack({
    topic: "finance.shopify_cost_push_failed",
    text: `⚠️ Shopify cost push failed: ${opts.sku} (${opts.store})`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `⚠️ *Shopify cost push failed*\n${opts.sku} → ${opts.store}\n_${opts.errorMessage}_` },
      },
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
