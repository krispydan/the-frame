/**
 * Amazon settlement → Xero manual journal. Pure builder, no DB, no network.
 *
 * Kept pure on purpose, matching `settlement-invoice-builder.ts`: the money
 * decisions are the part worth unit-testing exhaustively, and mixing them
 * with HTTP would make that impossible.
 *
 * Xero's ManualJournal sign convention is the one thing to keep straight:
 * **a positive LineAmount is a DEBIT, a negative one is a CREDIT.** Amazon's
 * settlement file uses the opposite intuition — revenue arrives positive and
 * fees negative — so every line gets its sign inverted on the way in. That
 * single inversion is where a whole class of "the journal posted but
 * backwards" bugs would live, so it is done once, here, and asserted in the
 * tests against real settlement figures.
 *
 * Two categories never reach the journal:
 *  - `tax_collected` / `tax_withheld` — Amazon collects and remits
 *    marketplace facilitator tax itself and the legs cancel exactly, so
 *    booking them would create a liability we do not owe. The caller asserts
 *    the residual is zero and alerts if it ever is not.
 *  - `clearing` — settlement-internal movements (the card charge covering a
 *    negative balance, micro deposits) that offset each other within the
 *    settlement and never touch revenue or expense.
 */

import type { SettlementSummary } from "./settlement-classify";

/** Resolved Xero account codes for the Amazon channel. */
export interface AmazonXeroConfig {
  sales: string;
  shippingIncome: string;
  discounts: string;
  refunds: string;
  commission: string;
  fbaFulfillment: string;
  fbaStorage: string;
  subscription: string;
  inboundFreight: string;
  outboundShipping: string;
  unclassified: string;
  /** BANK-type account the deposit lands in. Never touched by the journal itself. */
  clearing: string;
  /** Only used under the deferred revenue model. */
  deferredRevenue?: string | null;
  receivablesHolding?: string | null;
  tracking?: Array<{ TrackingCategoryID?: string; Name?: string; Option: string }>;
}

/** Category → config field. Categories absent here are deliberately not posted. */
const CATEGORY_ACCOUNT: Record<string, keyof AmazonXeroConfig> = {
  sales: "sales",
  shipping_income: "shippingIncome",
  discounts: "discounts",
  refunds: "refunds",
  commission: "commission",
  fba_fulfillment: "fbaFulfillment",
  fba_storage: "fbaStorage",
  subscription: "subscription",
  inbound_freight: "inboundFreight",
  outbound_shipping: "outboundShipping",
  unclassified: "unclassified",
};

export interface JournalLine {
  Description: string;
  AccountCode: string;
  LineAmount: number;
  Tracking?: Array<{ TrackingCategoryID?: string; Name?: string; Option: string }>;
}

export interface BuiltJournal {
  ok: true;
  payload: {
    Narration: string;
    Date: string;
    Status: "POSTED" | "DRAFT";
    JournalLines: JournalLine[];
  };
  /** Net of every line — must be ~0 for Xero to accept it. */
  balance: number;
  /** Non-fatal observations worth surfacing. */
  warnings: string[];
  /** Net deposit this settlement should produce. */
  netDeposit: number;
}

export interface BuildFailure {
  ok: false;
  error: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const LABELS: Record<string, string> = {
  sales: "Gross product sales",
  shipping_income: "Shipping income",
  discounts: "Promotions & discounts",
  refunds: "Refunds",
  commission: "Referral commission",
  fba_fulfillment: "FBA fulfilment fees",
  fba_storage: "FBA storage fees",
  subscription: "Selling plan subscription",
  inbound_freight: "Inbound freight to FBA",
  outbound_shipping: "Return shipping labels",
  unclassified: "Unclassified — needs review",
};

/**
 * Build the manual journal for one settlement.
 *
 * Under the **deferred** revenue model the sales credit goes to Deferred
 * Revenue rather than Sales, and shipment-time recognition later moves it —
 * matching how Shopify and Faire already behave, so the P&L stays consistent
 * across channels.
 *
 * The balancing line debits Receivables Holding (deferred model) or the
 * clearing account's contra. It is computed as the residual rather than
 * assumed equal to the settlement net, so the journal balances even if a fee
 * category is missing an account — the discrepancy shows up as a warning
 * instead of a rejected post.
 */
export function buildAmazonSettlementJournal(input: {
  summary: SettlementSummary;
  config: AmazonXeroConfig;
  /** Date to post under — normally the settlement period end. */
  date: string;
  model: "deferred" | "invoice";
  status?: "POSTED" | "DRAFT";
}): BuiltJournal | BuildFailure {
  const { summary, config, date, model } = input;
  const warnings: string[] = [];
  const lines: JournalLine[] = [];

  if (model === "invoice") {
    return {
      ok: false,
      error: "The settlement-date (invoice) model does not use a manual journal — build an ACCREC invoice instead.",
    };
  }

  const deferred = config.deferredRevenue;
  const holding = config.receivablesHolding;
  if (!deferred || !holding) {
    return {
      ok: false,
      error: "The deferred revenue model needs both `deferred_revenue` and `receivables_holding` account mappings.",
    };
  }

  for (const [category, amount] of Object.entries(summary.byCategory)) {
    // Settlement-internal movements offset within the settlement and never
    // touch revenue or expense.
    if (category === "clearing") continue;
    if (Math.abs(amount) < 0.005) continue;

    const field = CATEGORY_ACCOUNT[category];
    if (!field) {
      warnings.push(`No account mapping for category "${category}" (${amount}) — omitted from the journal.`);
      continue;
    }

    const accountCode = category === "sales" ? deferred : (config[field] as string);
    if (!accountCode) {
      warnings.push(`Account code missing for "${category}" (${amount}) — omitted from the journal.`);
      continue;
    }

    // Sign inversion: Amazon reports revenue positive and fees negative;
    // Xero wants positive = debit.
    lines.push({
      Description: category === "sales" && model === "deferred"
        ? `Deferred revenue — ${LABELS[category]}`
        : LABELS[category] ?? category,
      AccountCode: accountCode,
      LineAmount: round2(-amount),
      ...(config.tracking ? { Tracking: config.tracking } : {}),
    });
  }

  if (lines.length === 0) {
    return { ok: false, error: "Settlement produced no postable lines." };
  }

  const postedNet = round2(lines.reduce((s, l) => s + l.LineAmount, 0));

  // The receivable is pinned to the ACTUAL settlement net, not to whatever
  // the revenue and fee lines happen to sum to.
  //
  // This matters because the bank sweep clears Receivables Holding by the
  // real deposit amount. If the receivable were computed as the residual, any
  // amount excluded from the journal — a micro deposit, an omitted category —
  // would leave that difference stranded in Receivables Holding permanently,
  // growing by a little each settlement and reconciling to nothing.
  lines.push({
    Description: `Net settlement receivable — ${summary.settlementId}`,
    AccountCode: holding,
    LineAmount: round2(summary.net),
    ...(config.tracking ? { Tracking: config.tracking } : {}),
  });

  // Anything left over is the excluded remainder: settlement-internal
  // movements that did not fully offset (a micro deposit), or a category with
  // no account mapping. It goes to suspense with an explicit description
  // rather than being absorbed into the receivable, so the journal balances
  // AND the difference stays visible.
  const residual = round2(-(postedNet + round2(summary.net)));
  if (Math.abs(residual) >= 0.005) {
    lines.push({
      Description: `Settlement adjustment — difference between posted lines and net deposit (${summary.settlementId})`,
      AccountCode: config.unclassified,
      LineAmount: residual,
      ...(config.tracking ? { Tracking: config.tracking } : {}),
    });
    warnings.push(
      `Posted lines did not sum to the net deposit; ${residual} was booked to the suspense account ` +
      `(${config.unclassified}). Usually a bank artefact such as a micro deposit, or a fee category with no mapping.`,
    );
  }

  const balance = round2(lines.reduce((s, l) => s + l.LineAmount, 0));
  if (Math.abs(balance) > 0.01) {
    return { ok: false, error: `Journal does not balance (off by ${balance}). Refusing to post.` };
  }

  if (summary.unclassified.length > 0) {
    warnings.push(
      `${summary.unclassified.length} line(s) were unrecognised and booked to the suspense account.`,
    );
  }
  if (Math.abs(summary.taxResidual) >= 0.01) {
    warnings.push(
      `Marketplace facilitator tax did not net to zero (residual ${summary.taxResidual}). ` +
      `The journal excludes both tax legs, so this amount is currently unrecorded.`,
    );
  }

  return {
    ok: true,
    payload: {
      Narration:
        `Amazon settlement ${summary.settlementId} | Net ${summary.net.toFixed(2)} | ` +
        `${date} | Generated by the-frame`,
      Date: date,
      Status: input.status ?? "POSTED",
      JournalLines: lines,
    },
    balance,
    warnings,
    netDeposit: summary.net,
  };
}
