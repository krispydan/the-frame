/**
 * Amazon settlement journal builder tests.
 *
 * Pure function, no DB or mocks — the pattern this repo uses for
 * settlement-invoice-builder. The assertions centre on the two things that
 * would be expensive to get wrong and invisible afterwards: the Xero sign
 * convention (positive LineAmount = debit, the opposite of how Amazon reports
 * money), and the journal balancing to zero.
 */

import { describe, it, expect } from "vitest";
import { buildAmazonSettlementJournal, type AmazonXeroConfig } from "@/modules/integrations/lib/amazon/settlement-journal";
import { summariseSettlement, type SettlementRowInput } from "@/modules/integrations/lib/amazon/settlement-classify";

/** The real chart-of-accounts codes. */
const CONFIG: AmazonXeroConfig = {
  sales: "4010",
  shippingIncome: "4060",
  discounts: "4310",
  refunds: "4300",
  commission: "5410",
  fbaFulfillment: "5470",
  fbaStorage: "5475",
  subscription: "5480",
  inboundFreight: "5010",
  outboundShipping: "5300",
  unclassified: "5440",
  clearing: "1030",
  deferredRevenue: "2050",
  receivablesHolding: "1100",
};

const row = (t: string, at: string, d: string, amount: number): SettlementRowInput => ({
  transactionType: t, amountType: at, amountDescription: d, amount,
});

/** The real 4 Jun – 25 Jul settlement, one row per line type. */
const REAL_SETTLEMENT: SettlementRowInput[] = [
  row("Order", "ItemPrice", "Principal", 1652.0),
  row("Order", "Promotion", "Principal", -1176.0),
  row("Order", "ItemFees", "FBAPerUnitFulfillmentFee", -205.32),
  row("Order", "ItemFees", "Commission", -36.4),
  row("Order", "ItemPrice", "Tax", 34.73),
  row("Order", "ItemWithheldTax", "MarketplaceFacilitatorTax-Principal", -34.73),
  row("Refund", "ItemPrice", "Principal", -112.0),
  row("Refund", "ItemFees", "Commission", 5.6),
  row("Refund", "ItemFees", "RefundCommission", -1.12),
  row("other-transaction", "other-transaction", "Subscription Fee", -79.98),
  row("other-transaction", "other-transaction", "Inbound Transportation Fee", -21.3),
  row("other-transaction", "other-transaction", "Shipping label purchase for return", -5.48),
  row("other-transaction", "other-transaction", "Payable to Amazon", -126.14),
  row("other-transaction", "other-transaction", "Successful charge", 126.14),
  row("FBAFees", "FBA Amazon-Partnered Carrier Shipment Fee", "Base fee", -44.13),
  row("FBAFees", "FBA Amazon-Partnered Carrier Shipment Fee", "Discount on Fee", 44.13),
  row("Refund", "ItemPrice", "Tax", -8.93),
  row("Refund", "ItemWithheldTax", "MarketplaceFacilitatorTax-Principal", 8.93),
  row("Order", "ItemPrice", "Shipping", 2.99),
  row("Order", "Promotion", "Shipping", -2.99),
  row("Transfers", "Micro Deposit", "Micro Deposit", -0.01),
  row("FBAFees", "FBA Inventory Storage Fee", "Base fee", 0),
];

function build(rows: SettlementRowInput[], over: Partial<Parameters<typeof buildAmazonSettlementJournal>[0]> = {}) {
  return buildAmazonSettlementJournal({
    summary: summariseSettlement("26505809821", rows),
    config: CONFIG,
    date: "2026-07-06",
    model: "deferred",
    ...over,
  });
}

const lineFor = (j: { payload: { JournalLines: Array<{ AccountCode: string; LineAmount: number }> } }, code: string) =>
  j.payload.JournalLines.find((l) => l.AccountCode === code);

describe("sign convention", () => {
  it("credits revenue — Amazon reports sales positive, Xero wants negative for a credit", () => {
    const j = build(REAL_SETTLEMENT);
    expect(j.ok).toBe(true);
    if (!j.ok) return;
    // Sales go to Deferred Revenue under the deferred model.
    expect(lineFor(j, "2050")!.LineAmount).toBe(-1652);
  });

  it("debits fees — Amazon reports them negative, Xero wants positive for a debit", () => {
    const j = build(REAL_SETTLEMENT);
    if (!j.ok) return;
    expect(lineFor(j, "5470")!.LineAmount).toBe(205.32);  // FBA fulfilment
    expect(lineFor(j, "5480")!.LineAmount).toBe(79.98);   // subscription
  });

  it("debits promotions as contra-revenue, combining item and shipping promos", () => {
    const j = build(REAL_SETTLEMENT);
    if (!j.ok) return;
    expect(lineFor(j, "4310")!.LineAmount).toBe(1178.99); // 1176.00 item + 2.99 shipping
  });

  it("debits refunds", () => {
    const j = build(REAL_SETTLEMENT);
    if (!j.ok) return;
    expect(lineFor(j, "4300")!.LineAmount).toBe(112);
  });

  it("nets the commission credit against the debit on one line", () => {
    const j = build(REAL_SETTLEMENT);
    if (!j.ok) return;
    // −36.40 + 5.60 − 1.12 = −31.92 → debit 31.92
    expect(lineFor(j, "5410")!.LineAmount).toBe(31.92);
  });
});

describe("balancing", () => {
  it("balances to zero on the real settlement", () => {
    const j = build(REAL_SETTLEMENT);
    expect(j.ok).toBe(true);
    if (!j.ok) return;
    expect(j.balance).toBe(0);
  });

  it("pins the receivable to the real deposit so the bank sweep clears it exactly", () => {
    const j = build(REAL_SETTLEMENT);
    if (!j.ok) return;
    // The period netted 19.99. If the receivable were the residual of the
    // posted lines (20.00), the micro deposit would strand a cent in
    // Receivables Holding forever.
    expect(lineFor(j, "1100")!.LineAmount).toBe(19.99);
    expect(j.netDeposit).toBe(19.99);
  });

  it("books the excluded remainder to suspense rather than stranding it", () => {
    const j = build(REAL_SETTLEMENT);
    if (!j.ok) return;
    // The -0.01 micro deposit is a bank artefact excluded from revenue/fees.
    expect(lineFor(j, "5440")!.LineAmount).toBe(0.01);
    expect(j.warnings.join(" ")).toContain("micro deposit");
    expect(j.balance).toBe(0);
  });

  it("balances for a simple settlement too", () => {
    const j = build([
      row("Order", "ItemPrice", "Principal", 100),
      row("Order", "ItemFees", "Commission", -15),
    ]);
    if (!j.ok) return;
    expect(j.balance).toBe(0);
    expect(lineFor(j, "1100")!.LineAmount).toBe(85);
  });
});

describe("excluded categories", () => {
  it("omits both facilitator-tax legs — Amazon remits that tax itself", () => {
    const j = build(REAL_SETTLEMENT);
    if (!j.ok) return;
    // Booking them would create a liability we do not owe.
    expect(lineFor(j, "2230")).toBeUndefined();
  });

  it("omits settlement-internal clearing movements, which offset each other", () => {
    const j = build(REAL_SETTLEMENT);
    if (!j.ok) return;
    // "Payable to Amazon" + "Successful charge" cancel; the bank account is
    // touched by the sweep, never by the journal.
    expect(lineFor(j, "1030")).toBeUndefined();
  });

  it("warns when the tax legs fail to cancel, since the residual goes unrecorded", () => {
    const j = build([
      row("Order", "ItemPrice", "Principal", 100),
      row("Order", "ItemPrice", "Tax", 10),
      row("Order", "ItemWithheldTax", "MarketplaceFacilitatorTax-Principal", -7),
    ]);
    if (!j.ok) return;
    expect(j.warnings.join(" ")).toContain("did not net to zero");
    expect(j.warnings.join(" ")).toContain("currently unrecorded");
  });
});

describe("unclassified handling", () => {
  it("routes an unknown fee to the suspense account and warns", () => {
    const j = build([
      row("Order", "ItemPrice", "Principal", 100),
      row("other-transaction", "other-transaction", "Vine Enrollment Fee", -12),
    ]);
    if (!j.ok) return;
    expect(lineFor(j, "5440")!.LineAmount).toBe(12);
    expect(j.warnings.join(" ")).toContain("unrecognised");
    expect(j.balance).toBe(0);
  });
});

describe("guards", () => {
  it("refuses the invoice model rather than silently posting a journal", () => {
    const j = build(REAL_SETTLEMENT, { model: "invoice" });
    expect(j.ok).toBe(false);
    if (j.ok) return;
    expect(j.error).toContain("ACCREC invoice");
  });

  it("refuses to build without the deferred-model accounts", () => {
    const j = buildAmazonSettlementJournal({
      summary: summariseSettlement("s1", REAL_SETTLEMENT),
      config: { ...CONFIG, deferredRevenue: null, receivablesHolding: null },
      date: "2026-07-06", model: "deferred",
    });
    expect(j.ok).toBe(false);
  });

  it("refuses an empty settlement rather than posting a no-op journal", () => {
    const j = build([]);
    expect(j.ok).toBe(false);
  });

  it("still balances when an account mapping is missing, and says what was dropped", () => {
    // Dropping a line silently would post an unbalanced-looking journal that
    // Xero accepts but which no longer ties to the deposit.
    const j = buildAmazonSettlementJournal({
      summary: summariseSettlement("s1", [
        row("Order", "ItemPrice", "Principal", 100),
        row("other-transaction", "other-transaction", "Subscription Fee", -40),
      ]),
      config: { ...CONFIG, subscription: "" },
      date: "2026-07-06", model: "deferred",
    });
    if (!j.ok) return;
    expect(j.balance).toBe(0);
    expect(j.warnings.join(" ")).toContain("subscription");
    // The dropped amount lands in suspense, not silently in the receivable.
    expect(j.warnings.join(" ")).toContain("suspense account");
  });
});

describe("metadata", () => {
  it("writes a traceable narration", () => {
    const j = build(REAL_SETTLEMENT);
    if (!j.ok) return;
    expect(j.payload.Narration).toContain("26505809821");
    expect(j.payload.Narration).toContain("19.99");
    expect(j.payload.Date).toBe("2026-07-06");
  });

  it("supports DRAFT status for a first live run", () => {
    const j = build(REAL_SETTLEMENT, { status: "DRAFT" });
    if (!j.ok) return;
    expect(j.payload.Status).toBe("DRAFT");
  });

  it("attaches the tracking option to every line when configured", () => {
    const j = buildAmazonSettlementJournal({
      summary: summariseSettlement("s1", REAL_SETTLEMENT),
      config: { ...CONFIG, tracking: [{ Name: "Sales Channel", Option: "Amazon" }] },
      date: "2026-07-06", model: "deferred",
    });
    if (!j.ok) return;
    expect(j.payload.JournalLines.every((l) => l.Tracking?.[0]?.Option === "Amazon")).toBe(true);
  });
});
