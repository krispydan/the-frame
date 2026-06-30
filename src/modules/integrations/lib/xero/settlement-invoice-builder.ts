/**
 * Build a Xero ACCREC (sales) Invoice from a channel payout — the
 * settlement-date revenue model documented in
 * `finance/Jaxy_Channel_Payout_Mapping_Guide.docx`.
 *
 * One invoice per payout. Gross revenue posts as POSITIVE line items (credits
 * the channel's Sales account, debits Accounts Receivable); every fee posts as
 * a NEGATIVE line item (debits the fee account, credits AR). The invoice TOTAL
 * therefore equals the NET payout — the exact amount that lands in the bank —
 * so the bank deposit reconciles 1:1 against the invoice in one click.
 *
 * This REPLACES the old deferred-revenue model in journal-builder.ts, which
 * rerouted sales → 2050 Deferred Revenue and net → 1100 Receivables Holding
 * and relied on a separate shipment-recognition job to move deferred → sales
 * (which only ever fired for Faire, stranding all Shopify Wholesale revenue in
 * deferred). Here revenue is recognized at settlement, per the guide.
 *
 * Pure / side-effect-free: takes resolved account codes, returns the payload.
 * No DB, no Xero calls — so it is unit-testable and dry-run-able.
 */

import type { PayoutSummary } from "./payout-aggregator";

/** A single resolved invoice component, pre-mapped to a Xero account. */
export type InvoiceComponent = {
  /** Mapping-guide category, e.g. "sales" | "fees" | "commission". */
  category: string;
  /** Resolved Xero account code, e.g. "4040". */
  accountCode: string;
  /** Positive magnitude of the component (never signed here). */
  amount: number;
  /**
   * revenue  → positive invoice line (CR revenue / income / liability, DR AR)
   * contra   → negative invoice line (DR fee / expense / contra-revenue, CR AR)
   */
  kind: "revenue" | "contra";
  description: string;
};

export type InvoiceTracking = {
  trackingCategoryId: string;
  trackingCategoryName: string | null;
  trackingOptionId: string;
  trackingOptionName: string | null;
};

export type XeroInvoiceLineItem = {
  Description: string;
  Quantity: 1;
  UnitAmount: number; // signed: + = revenue line, − = fee/contra line
  AccountCode: string;
  Tracking?: Array<{ TrackingCategoryID: string; Name?: string; Option: string }>;
};

export type XeroInvoicePayload = {
  Type: "ACCREC";
  Contact: { Name: string };
  Date: string;
  DueDate: string;
  /** Stable natural key for idempotency — one invoice per payout. */
  InvoiceNumber: string;
  Reference: string;
  Status: "AUTHORISED" | "DRAFT";
  LineAmountTypes: "NoTax";
  LineItems: XeroInvoiceLineItem[];
};

export type BuildInvoiceResult =
  | { ok: true; payload: XeroInvoicePayload; total: number; delta: number; warnings: string[] }
  | { ok: false; error: string };

export type SettlementInvoiceInput = {
  /** Logical channel: "shopify_dtc" | "shopify_wholesale" | "faire" | … */
  channel: string;
  /** Xero contact (the processor / marketplace), e.g. "Faire". */
  contactName: string;
  /** Stable per-payout reference → InvoiceNumber (idempotency key). */
  invoiceNumber: string;
  /** Human reference shown on the invoice. */
  reference: string;
  /** Invoice date — the payout date. */
  date: string;
  /** Expected invoice total = the NET amount deposited in the bank. */
  netPayout: number;
  components: InvoiceComponent[];
  tracking?: InvoiceTracking | null;
  status?: "AUTHORISED" | "DRAFT";
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Convert resolved components into a Xero ACCREC invoice payload, validating
 * that the line total ties to the net payout (Faire/Shopify cents drift and
 * Faire's documented ±$10-60 payout anomalies surface here as a delta warning,
 * never a silent imbalance).
 */
export function buildSettlementInvoice(input: SettlementInvoiceInput): BuildInvoiceResult {
  const warnings: string[] = [];
  if (input.components.length === 0) {
    return { ok: false, error: `No invoice components for payout ${input.invoiceNumber}` };
  }

  const trackingLine = input.tracking
    ? [{
        TrackingCategoryID: input.tracking.trackingCategoryId,
        Name: input.tracking.trackingCategoryName ?? undefined,
        Option: input.tracking.trackingOptionName ?? "",
      }]
    : undefined;

  const LineItems: XeroInvoiceLineItem[] = input.components
    .filter((c) => round2(c.amount) !== 0)
    .map((c) => ({
      Description: c.description,
      Quantity: 1 as const,
      // revenue → positive (CR revenue), contra → negative (DR fee)
      UnitAmount: c.kind === "revenue" ? round2(c.amount) : -round2(c.amount),
      AccountCode: c.accountCode,
      ...(trackingLine ? { Tracking: trackingLine } : {}),
    }));

  if (LineItems.length === 0) {
    return { ok: false, error: `All components zero for payout ${input.invoiceNumber}` };
  }

  const total = round2(LineItems.reduce((s, l) => s + l.UnitAmount, 0));
  const delta = round2(total - input.netPayout);

  if (Math.abs(delta) > 0.01) {
    warnings.push(
      `Invoice total ${total.toFixed(2)} ≠ net payout ${input.netPayout.toFixed(2)} ` +
        `(delta ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}). Review before posting.`,
    );
  }
  if (total <= 0) {
    warnings.push(`Invoice total is ${total.toFixed(2)} (≤ 0) — a net-negative payout cannot post as ACCREC; needs a credit note.`);
  }

  return {
    ok: true,
    total,
    delta,
    warnings,
    payload: {
      Type: "ACCREC",
      Contact: { Name: input.contactName },
      Date: input.date,
      DueDate: input.date,
      InvoiceNumber: input.invoiceNumber,
      Reference: input.reference,
      Status: input.status ?? "AUTHORISED",
      LineAmountTypes: "NoTax",
      LineItems,
    },
  };
}

// ───────────────────────── channel adapters ─────────────────────────

/** Resolved Xero account codes for a Shopify-family payout (from xero_account_mappings). */
export type ShopifyInvoiceAccounts = {
  sales: string;       // 4000 DTC / 4030 Wholesale
  refunds: string;     // 4300
  fees: string;        // 5400 / 5430 (Afterpay)
  adjustments: string; // 5900 / 4200 — bucket account for signed balance adjustments
};

const HUMAN: Record<string, string> = {
  shopify_dtc: "Shopify Retail",
  shopify_afterpay: "Shopify Afterpay",
  shopify_wholesale: "Shopify Wholesale",
  faire: "Faire",
};

/**
 * Map a bucketed Shopify PayoutSummary → ACCREC invoice components per the guide.
 * The "clearing" bucket is intentionally dropped — under the invoice model the
 * net is the invoice total (AR), not a line. (Shipping/tax stay folded into the
 * gross `sales` bucket until per-order settlement breakout lands — same data the
 * current journal uses, so no regression.)
 */
export function shopifyPayoutToComponents(
  summary: PayoutSummary,
  accounts: ShopifyInvoiceAccounts,
): InvoiceComponent[] {
  const human = HUMAN[summary.platform] ?? summary.platform;
  const label = `${human} payout ${summary.payoutId}`;
  const out: InvoiceComponent[] = [];
  for (const b of summary.categories) {
    switch (b.category) {
      case "sales":
        out.push({ category: "sales", accountCode: accounts.sales, amount: b.amount, kind: "revenue", description: `Gross sales — ${label} (${b.txCount} tx)` });
        break;
      case "refunds":
        out.push({ category: "refunds", accountCode: accounts.refunds, amount: b.amount, kind: "contra", description: `Refunds — ${label} (${b.txCount} tx)` });
        break;
      case "fees":
        out.push({ category: "fees", accountCode: accounts.fees, amount: b.amount, kind: "contra", description: `Processing fees — ${label} (${b.txCount} tx)` });
        break;
      case "adjustments":
        // Signed: positive = money INTO our balance (revenue line), negative = expense (contra).
        if (b.amount >= 0) out.push({ category: "adjustments", accountCode: accounts.adjustments, amount: b.amount, kind: "revenue", description: `Balance adjustments (+) — ${label}` });
        else out.push({ category: "adjustments", accountCode: accounts.adjustments, amount: Math.abs(b.amount), kind: "contra", description: `Balance adjustments (−) — ${label}` });
        break;
      case "clearing":
        break; // net = invoice total, not a line
    }
  }
  return out;
}

/** Resolved account codes for a Faire payout. */
export type FaireInvoiceAccounts = {
  sales: string;             // 4040
  commission: string;        // 5450
  paymentProcessing: string; // 5455
  shippingLabels: string;    // 5460
  shippingIncome?: string;   // 4060 (positive delta)
  inventoryAdjustments?: string; // 5900 (negative delta)
};

/** Minimal shape of a Faire payout we need to build an invoice. */
export type FaireInvoiceSummary = {
  displayId: string;
  netOrderTotal: number;
  commission: number;
  paymentFee: number;
  totalPayout: number;
};

/**
 * Map a Faire payout → ACCREC invoice components per guide §3a, including the
 * documented payout-anomaly delta plug (routed to shipping income / inventory
 * adjustments / shipping labels depending on direction).
 */
export function fairePayoutToComponents(
  s: FaireInvoiceSummary,
  accounts: FaireInvoiceAccounts,
): InvoiceComponent[] {
  const label = `Faire order ${s.displayId}`;
  const out: InvoiceComponent[] = [
    { category: "sales", accountCode: accounts.sales, amount: s.netOrderTotal, kind: "revenue", description: `Gross order total — ${label}` },
  ];
  if (s.commission > 0) out.push({ category: "commission", accountCode: accounts.commission, amount: s.commission, kind: "contra", description: `Faire commission — ${label}` });
  if (s.paymentFee > 0) out.push({ category: "payment_processing", accountCode: accounts.paymentProcessing, amount: s.paymentFee, kind: "contra", description: `Faire payment processing — ${label}` });

  const expected = round2(s.netOrderTotal - s.commission - s.paymentFee);
  const delta = round2(s.totalPayout - expected);
  if (Math.abs(delta) >= 0.01) {
    if (delta > 0) {
      // Faire paid MORE than fees imply → income (buyer-paid shipping / overpayment).
      out.push({ category: "shipping_income", accountCode: accounts.shippingIncome ?? accounts.shippingLabels, amount: delta, kind: "revenue", description: `Faire payout delta (+) — ${label} (buyer-paid shipping / overpayment, review)` });
    } else {
      // Faire paid LESS → expense (label cost / damaged deduction / hidden fee).
      out.push({ category: "shipping_labels", accountCode: accounts.inventoryAdjustments ?? accounts.shippingLabels, amount: Math.abs(delta), kind: "contra", description: `Faire payout delta (−) — ${label} (label / deduction, review)` });
    }
  }
  return out;
}
