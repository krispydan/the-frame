/**
 * Amazon settlement row classification — a pure function, no DB, no network.
 *
 * Amazon's settlement flat file describes every line with three free-text
 * columns (`transaction-type`, `amount-type`, `amount-description`) whose
 * combinations are not documented exhaustively and grow over time. This maps
 * them onto our accounting categories.
 *
 * Every mapping below was derived from the 288 settlement rows actually
 * present on this account (4 Jun – 25 Jul 2026), not from Amazon's docs. The
 * test suite asserts the full observed taxonomy, so a mapping change that
 * would silently re-route real money fails loudly.
 *
 * Two rules matter more than the table itself:
 *
 *  - **Unknown combinations are never silently absorbed.** They classify as
 *    `unclassified`, post to a suspense account, and raise an alert. Amazon
 *    will introduce fee types we have not seen (long-term storage, disposal,
 *    removal, Vine); the failure mode we refuse is one where they quietly
 *    land in whatever bucket happened to match a substring.
 *
 *  - **Marketplace facilitator tax is netted, not booked.** Amazon collects
 *    sales tax and remits it itself; the money never reaches us. The two legs
 *    (`ItemPrice/Tax` and `ItemWithheldTax/MarketplaceFacilitatorTax-*`)
 *    cancel exactly in the observed data, so booking them would create a tax
 *    liability we do not owe. They are classified separately so the caller
 *    can assert the pair nets to zero and alert if it ever does not.
 */

/** Accounting category a settlement line maps to. */
export type SettlementCategory =
  | "sales"               // gross product revenue
  | "shipping_income"     // shipping charged to the buyer
  | "discounts"           // promotions — contra-revenue
  | "refunds"             // refunded principal
  | "commission"          // Amazon referral fee
  | "fba_fulfillment"     // FBA pick/pack/ship, per unit
  | "fba_storage"         // FBA inventory storage
  | "subscription"        // Professional selling plan
  | "inbound_freight"     // freight into FBA (partnered carrier, inbound transport)
  | "outbound_shipping"   // return labels and similar
  | "tax_collected"       // sales tax collected — netted, see module docs
  | "tax_withheld"        // facilitator tax withheld — netted, see module docs
  | "clearing"            // settlement-internal movements; net to zero
  | "unclassified";       // unknown — suspense account + alert

export interface SettlementRowInput {
  transactionType?: string | null;
  amountType?: string | null;
  amountDescription?: string | null;
  amount: number;
}

export interface Classification {
  category: SettlementCategory;
  /** True for the two facilitator-tax legs, which are netted rather than booked. */
  isTaxLeg: boolean;
  /** True when nothing matched and the row needs a human. */
  isUnknown: boolean;
  /** Short human explanation, used in alerts and the dashboard. */
  reason: string;
}

const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

/**
 * Classify one settlement line.
 *
 * Matching is on the (amount_type, amount_description) pair first, since that
 * is what actually carries the meaning; `transaction_type` disambiguates
 * order-vs-refund for otherwise identical fee rows.
 */
export function classifySettlementRow(row: SettlementRowInput): Classification {
  const tx = norm(row.transactionType);
  const type = norm(row.amountType);
  const desc = norm(row.amountDescription);

  const isRefund = tx === "refund";

  // ── Facilitator tax: both legs, netted rather than booked ──
  if (type === "itemwithheldtax") {
    return { category: "tax_withheld", isTaxLeg: true, isUnknown: false,
      reason: "Marketplace facilitator tax withheld by Amazon" };
  }
  if (type === "itemprice" && desc === "tax") {
    return { category: "tax_collected", isTaxLeg: true, isUnknown: false,
      reason: "Sales tax collected by Amazon on our behalf" };
  }

  // ── Principal ──
  if (type === "itemprice" && desc === "principal") {
    return isRefund
      ? { category: "refunds", isTaxLeg: false, isUnknown: false, reason: "Refunded product sale" }
      : { category: "sales", isTaxLeg: false, isUnknown: false, reason: "Gross product sales" };
  }
  if (type === "itemprice" && desc === "shipping") {
    return { category: "shipping_income", isTaxLeg: false, isUnknown: false,
      reason: isRefund ? "Refunded shipping income" : "Shipping charged to buyer" };
  }

  // ── Promotions (contra-revenue) ──
  // At 71% of gross during launch this is far too material to net against
  // revenue; it gets its own line so true demand stays visible.
  if (type === "promotion") {
    return { category: "discounts", isTaxLeg: false, isUnknown: false,
      reason: desc === "shipping" ? "Shipping promotion" : "Promotional discount" };
  }

  // ── Per-item fees ──
  if (type === "itemfees") {
    if (desc === "commission" || desc === "refundcommission") {
      return { category: "commission", isTaxLeg: false, isUnknown: false,
        reason: desc === "refundcommission" ? "Refund administration fee" : "Referral commission" };
    }
    if (desc.includes("fbaperunitfulfillmentfee") || desc.includes("fulfillmentfee")) {
      return { category: "fba_fulfillment", isTaxLeg: false, isUnknown: false,
        reason: "FBA per-unit fulfilment fee" };
    }
    if (desc.includes("shippingchargeback") || desc.includes("shippinghb")) {
      return { category: "outbound_shipping", isTaxLeg: false, isUnknown: false,
        reason: "Shipping chargeback" };
    }
    if (desc.includes("giftwrap")) {
      return { category: "commission", isTaxLeg: false, isUnknown: false, reason: "Gift wrap fee" };
    }
  }

  // ── FBA service fees ──
  if (tx === "fbafees" || type.startsWith("fba ")) {
    if (type.includes("storage")) {
      return { category: "fba_storage", isTaxLeg: false, isUnknown: false, reason: "FBA inventory storage fee" };
    }
    if (type.includes("partnered carrier") || type.includes("shipment fee")) {
      return { category: "inbound_freight", isTaxLeg: false, isUnknown: false,
        reason: "Amazon-partnered carrier inbound shipment fee" };
    }
    if (type.includes("disposal") || type.includes("removal")) {
      return { category: "fba_storage", isTaxLeg: false, isUnknown: false, reason: "FBA disposal/removal fee" };
    }
  }

  // ── Account-level and one-off transactions ──
  if (tx === "other-transaction" || type === "other-transaction") {
    if (desc.includes("subscription")) {
      return { category: "subscription", isTaxLeg: false, isUnknown: false, reason: "Professional selling plan subscription" };
    }
    if (desc.includes("inbound transportation") || desc.includes("inbound freight")) {
      return { category: "inbound_freight", isTaxLeg: false, isUnknown: false, reason: "Inbound transportation to FBA" };
    }
    if (desc.includes("shipping label")) {
      return { category: "outbound_shipping", isTaxLeg: false, isUnknown: false, reason: "Return shipping label" };
    }
    if (desc.includes("storage")) {
      return { category: "fba_storage", isTaxLeg: false, isUnknown: false, reason: "Storage fee" };
    }
    // "Payable to Amazon" and its matching "Successful charge" are the card
    // charge raised when a settlement nets negative. They offset each other
    // and never touch revenue or expense.
    if (desc.includes("payable to amazon") || desc.includes("successful charge") || desc.includes("failed charge")) {
      return { category: "clearing", isTaxLeg: false, isUnknown: false,
        reason: "Card charge covering a negative settlement balance (offsetting pair)" };
    }
  }

  // ── Bank transfers ──
  if (tx === "transfers" || type.includes("micro deposit") || desc.includes("micro deposit")) {
    return { category: "clearing", isTaxLeg: false, isUnknown: false, reason: "Bank verification / transfer" };
  }

  return {
    category: "unclassified",
    isTaxLeg: false,
    isUnknown: true,
    reason: `Unrecognised settlement line: transaction_type="${row.transactionType ?? ""}", amount_type="${row.amountType ?? ""}", amount_description="${row.amountDescription ?? ""}"`,
  };
}

/**
 * The `xero_account_mappings` category each settlement category books to.
 *
 * Kept separate from classification so the accounting decision can change
 * without touching the interpretation of Amazon's data.
 */
export const CATEGORY_TO_MAPPING: Record<Exclude<SettlementCategory, "tax_collected" | "tax_withheld">, string> = {
  sales: "sales",
  shipping_income: "shipping",
  discounts: "discounts",
  refunds: "refunds",
  commission: "fees",
  fba_fulfillment: "fba_fulfillment",
  fba_storage: "fba_storage",
  subscription: "subscription",
  inbound_freight: "inbound_freight",
  outbound_shipping: "outbound_shipping",
  clearing: "clearing",
  unclassified: "unclassified",
};

/** Categories that increase revenue (credit side) rather than expense. */
export const CREDIT_CATEGORIES: ReadonlySet<SettlementCategory> = new Set<SettlementCategory>([
  "sales",
  "shipping_income",
]);

export interface SettlementSummary {
  settlementId: string;
  /** Net of every line — should equal the deposit. */
  net: number;
  /** Per-category totals, signed as Amazon reports them. */
  byCategory: Record<string, number>;
  /** Gross sales (positive). */
  grossSales: number;
  /** Promotions as a positive magnitude. */
  promotions: number;
  /** All Amazon fees as a positive magnitude. */
  totalFees: number;
  /** Refunded principal as a positive magnitude. */
  refunds: number;
  /** Residual of the two facilitator-tax legs. Should be 0.00. */
  taxResidual: number;
  /** Lines that did not classify — each needs a human. */
  unclassified: Array<{ reason: string; amount: number }>;
  lineCount: number;
}

/**
 * Aggregate classified settlement lines into the shape a journal or invoice
 * builder needs.
 *
 * `taxResidual` is deliberately surfaced rather than assumed zero: netting
 * the facilitator-tax legs is only safe while they actually cancel, and if
 * Amazon ever changes that behaviour we want an alert, not a silent
 * imbalance in the books.
 */
export function summariseSettlement(
  settlementId: string,
  rows: SettlementRowInput[],
): SettlementSummary {
  const byCategory: Record<string, number> = {};
  const unclassified: Array<{ reason: string; amount: number }> = [];
  let taxCollected = 0;
  let taxWithheld = 0;
  let net = 0;

  for (const row of rows) {
    const c = classifySettlementRow(row);
    net += row.amount;

    if (c.category === "tax_collected") { taxCollected += row.amount; continue; }
    if (c.category === "tax_withheld") { taxWithheld += row.amount; continue; }

    byCategory[c.category] = round2((byCategory[c.category] ?? 0) + row.amount);
    if (c.isUnknown) unclassified.push({ reason: c.reason, amount: row.amount });
  }

  const feeCategories: SettlementCategory[] = [
    "commission", "fba_fulfillment", "fba_storage", "subscription",
    "inbound_freight", "outbound_shipping",
  ];

  return {
    settlementId,
    net: round2(net),
    byCategory,
    grossSales: round2(byCategory.sales ?? 0),
    promotions: round2(Math.abs(byCategory.discounts ?? 0)),
    totalFees: round2(feeCategories.reduce((s, c) => s + Math.abs(byCategory[c] ?? 0), 0)),
    refunds: round2(Math.abs(byCategory.refunds ?? 0)),
    taxResidual: round2(taxCollected + taxWithheld),
    unclassified,
    lineCount: rows.length,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
