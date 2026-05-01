/**
 * Build a Xero ManualJournal payload from a PayoutSummary + saved account
 * mappings + a tracking option.
 *
 * Xero ManualJournals API expects the request body shape:
 *   {
 *     ManualJournals: [{
 *       Narration: string,
 *       Date: "YYYY-MM-DD",
 *       Status: "POSTED" | "DRAFT",
 *       JournalLines: [{
 *         LineAmount: number,    // POSITIVE for debit, NEGATIVE for credit
 *         AccountCode: string,
 *         Description: string,
 *         Tracking: [{ TrackingCategoryID, Option }] | undefined
 *       }]
 *     }]
 *   }
 *
 * Total of all LineAmount values must net to zero for the journal to post.
 */

import type { PayoutSummary } from "./payout-aggregator";

export type AccountMapping = {
  category: string;
  xeroAccountCode: string;
  xeroAccountName: string | null;
  side: "credit" | "debit";
};

export type TrackingMapping = {
  trackingCategoryId: string;
  trackingCategoryName: string | null;
  trackingOptionId: string;
  trackingOptionName: string | null;
};

export type XeroJournalLine = {
  LineAmount: number;
  AccountCode: string;
  Description: string;
  Tracking?: Array<{
    TrackingCategoryID: string;
    Name?: string;
    Option: string;
  }>;
};

export type XeroManualJournalPayload = {
  Narration: string;
  Date: string;
  Status: "POSTED" | "DRAFT";
  JournalLines: XeroJournalLine[];
};

export type BuildJournalResult =
  | { ok: true; payload: XeroManualJournalPayload; warnings: string[] }
  | { ok: false; error: string; missingMappings?: string[] };

const SIDE_FROM_GUIDE: Record<string, "credit" | "debit"> = {
  sales: "credit",
  shipping: "credit",
  tax: "credit",
  refunds: "debit",
  discounts: "debit",
  fees: "debit",
  adjustments: "debit",
  damaged_missing: "debit",
  commission: "debit",
  payment_processing: "debit",
  shipping_labels: "debit",
  outbound_shipping: "debit",
  clearing: "debit",
};

export function buildPayoutJournal(opts: {
  summary: PayoutSummary;
  /** category → mapping for the relevant platform. */
  mappings: Map<string, AccountMapping>;
  tracking: TrackingMapping | null;
  /** "POSTED" finalises the journal in Xero; "DRAFT" leaves it for review. */
  status?: "POSTED" | "DRAFT";
  /** Optional override for the journal Date — defaults to summary.payoutDate. */
  date?: string;
}): BuildJournalResult {
  const { summary, mappings, tracking } = opts;
  const status = opts.status ?? "POSTED";
  const date = opts.date ?? summary.payoutDate;
  const warnings: string[] = [];
  const missingMappings: string[] = [];

  const lines: XeroJournalLine[] = [];

  for (const bucket of summary.categories) {
    const mapping = mappings.get(bucket.category);
    if (!mapping || !mapping.xeroAccountCode) {
      missingMappings.push(bucket.category);
      continue;
    }

    // Determine sign from the mapping guide convention.
    const side = SIDE_FROM_GUIDE[bucket.category] ?? "debit";
    // Xero LineAmount: positive = debit, negative = credit
    let lineAmount = side === "debit" ? bucket.amount : -bucket.amount;

    // Adjustments can be positive or negative in the source data — preserve sign
    // and let it land on the configured side. If the bucket amount is negative
    // and side is debit, that's effectively a credit; LineAmount handles it.
    if (bucket.category === "adjustments") {
      // bucket.amount preserves sign from aggregator; map directly.
      lineAmount = bucket.amount;  // positive bucket -> debit side, negative -> credit
    }

    lines.push({
      LineAmount: lineAmount,
      AccountCode: mapping.xeroAccountCode,
      Description: descriptionFor(bucket.category, summary, bucket.amount, bucket.txCount),
      Tracking: tracking
        ? [{
            TrackingCategoryID: tracking.trackingCategoryId,
            Option: tracking.trackingOptionName ?? "",
          }]
        : undefined,
    });
  }

  if (missingMappings.length > 0) {
    return {
      ok: false,
      error: `Missing account mapping for categories: ${missingMappings.join(", ")}. Set them under Settings → Integrations → Xero.`,
      missingMappings,
    };
  }

  // Verify the journal balances. The clearing line acts as the balancing
  // entry — sales (cr) - refunds (dr) - fees (dr) + adjustments (signed) =
  // clearing (dr). Floating-point cents drift can leave tiny non-zero sum;
  // tolerate up to 1c.
  const sum = lines.reduce((acc, l) => acc + l.LineAmount, 0);
  if (Math.abs(sum) > 0.01) {
    warnings.push(
      `Journal lines net to ${sum.toFixed(2)} instead of 0 ` +
        "(reconciliation delta from Shopify payout). Review in Xero before posting.",
    );
  }

  const narration = buildNarration(summary, lines.length, warnings);

  return {
    ok: true,
    payload: { Narration: narration, Date: date, Status: status, JournalLines: lines },
    warnings,
  };
}

function descriptionFor(
  category: string,
  summary: PayoutSummary,
  amount: number,
  txCount: number,
): string {
  const txLabel = txCount === 1 ? "1 tx" : `${txCount} txs`;
  const platform = humanPlatform(summary.platform);
  switch (category) {
    case "sales":       return `Gross sales — ${platform} payout ${summary.payoutId} (${txLabel})`;
    case "refunds":     return `Refunds — ${platform} payout ${summary.payoutId} (${txLabel})`;
    case "fees":        return `Processing fees — ${platform} payout ${summary.payoutId} (${txLabel})`;
    case "adjustments": return `Adjustments — ${platform} payout ${summary.payoutId} (${txLabel}, signed ${amount >= 0 ? "+" : ""}${amount.toFixed(2)})`;
    case "clearing":    return `Net payout to clearing — ${platform} payout ${summary.payoutId}`;
    default:            return `${category} — ${platform} payout ${summary.payoutId} (${txLabel})`;
  }
}

function buildNarration(summary: PayoutSummary, lineCount: number, warnings: string[]): string {
  const platform = humanPlatform(summary.platform);
  const parts = [
    `${platform} payout #${summary.payoutId}`,
    `${summary.payoutDate}`,
    `Net ${summary.currency} ${summary.netPayoutAmount.toFixed(2)}`,
    `${lineCount} line${lineCount === 1 ? "" : "s"}`,
    `${summary.orderIds.length} order${summary.orderIds.length === 1 ? "" : "s"}`,
  ];
  if (summary.reconciliationDelta !== 0) {
    parts.push(`reconciliation delta ${summary.reconciliationDelta.toFixed(2)}`);
  }
  if (warnings.length > 0) {
    parts.push(`(${warnings.length} warning${warnings.length === 1 ? "" : "s"})`);
  }
  parts.push("Generated by the-frame");
  return parts.join(" | ");
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
