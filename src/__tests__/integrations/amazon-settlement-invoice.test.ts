/**
 * Amazon settlement → ACCREC invoice adapter tests.
 *
 * Under the settlement-date model the invoice total must equal the deposit,
 * because that is what makes the bank reconcile 1:1. Two Amazon-specific
 * exclusions (facilitator tax, settlement-internal movements) mean the mapped
 * lines do NOT naturally sum to the deposit, so the tie-out is the thing worth
 * pinning down.
 *
 * Pure functions, no DB or mocks — matching the existing
 * settlement-invoice-builder tests.
 */

import { describe, it, expect } from "vitest";
import {
  amazonSettlementToComponents,
  buildSettlementInvoice,
  type AmazonInvoiceAccounts,
} from "@/modules/integrations/lib/xero/settlement-invoice-builder";
import { summariseSettlement, type SettlementRowInput } from "@/modules/integrations/lib/amazon/settlement-classify";

const ACCOUNTS: AmazonInvoiceAccounts = {
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
};

const row = (t: string, at: string, d: string, amount: number): SettlementRowInput => ({
  transactionType: t, amountType: at, amountDescription: d, amount,
});

/** The real 4 Jun – 25 Jul settlement, which nets $19.99. */
const REAL: SettlementRowInput[] = [
  row("Order", "ItemPrice", "Principal", 1652.0),
  row("Order", "Promotion", "Principal", -1176.0),
  row("Order", "ItemFees", "FBAPerUnitFulfillmentFee", -205.32),
  row("Order", "ItemFees", "Commission", -36.4),
  row("Order", "ItemPrice", "Tax", 34.73),
  row("Order", "ItemWithheldTax", "MarketplaceFacilitatorTax-Principal", -34.73),
  row("Refund", "ItemPrice", "Principal", -112.0),
  row("Refund", "ItemPrice", "Tax", -8.93),
  row("Refund", "ItemWithheldTax", "MarketplaceFacilitatorTax-Principal", 8.93),
  row("Refund", "ItemFees", "Commission", 5.6),
  row("Refund", "ItemFees", "RefundCommission", -1.12),
  row("other-transaction", "other-transaction", "Subscription Fee", -79.98),
  row("other-transaction", "other-transaction", "Inbound Transportation Fee", -21.3),
  row("other-transaction", "other-transaction", "Shipping label purchase for return", -5.48),
  row("other-transaction", "other-transaction", "Payable to Amazon", -126.14),
  row("other-transaction", "other-transaction", "Successful charge", 126.14),
  row("FBAFees", "FBA Amazon-Partnered Carrier Shipment Fee", "Base fee", -44.13),
  row("FBAFees", "FBA Amazon-Partnered Carrier Shipment Fee", "Discount on Fee", 44.13),
  row("Order", "ItemPrice", "Shipping", 2.99),
  row("Order", "Promotion", "Shipping", -2.99),
  row("Transfers", "Micro Deposit", "Micro Deposit", -0.01),
];

const componentsFor = (rows: SettlementRowInput[], id = "26505809821") => {
  const s = summariseSettlement(id, rows);
  return { summary: s, components: amazonSettlementToComponents({ settlementId: id, byCategory: s.byCategory, net: s.net }, ACCOUNTS) };
};

/** Signed total the invoice builder will produce from these components. */
const signedTotal = (cs: ReturnType<typeof componentsFor>["components"]) =>
  Math.round(cs.reduce((t, c) => t + (c.kind === "revenue" ? c.amount : -c.amount), 0) * 100) / 100;

const find = (cs: ReturnType<typeof componentsFor>["components"], code: string) =>
  cs.find((c) => c.accountCode === code);

describe("component mapping", () => {
  it("maps sales to revenue and fees to contra", () => {
    const { components } = componentsFor(REAL);
    expect(find(components, "4010")).toMatchObject({ kind: "revenue", amount: 1652 });
    expect(find(components, "5470")).toMatchObject({ kind: "contra", amount: 205.32 });
    expect(find(components, "5480")).toMatchObject({ kind: "contra", amount: 79.98 });
  });

  it("treats promotions as contra rather than reducing the sales line", () => {
    const { components } = componentsFor(REAL);
    // Netting them into 4010 would hide that promotions ran at ~71% of gross.
    expect(find(components, "4310")).toMatchObject({ kind: "contra", amount: 1178.99 });
    expect(find(components, "4010")!.amount).toBe(1652);
  });

  it("nets refund credits into the commission line", () => {
    const { components } = componentsFor(REAL);
    expect(find(components, "5410")).toMatchObject({ kind: "contra", amount: 31.92 });
  });

  it("flips a category to the revenue side when its sign inverts", () => {
    // Refund credits can exceed the fees in a quiet period. The builder takes
    // the sign from `kind`, so a negative magnitude would double-negate.
    const { components } = componentsFor([
      row("Order", "ItemPrice", "Principal", 100),
      row("Refund", "ItemFees", "Commission", 8),
    ]);
    expect(find(components, "5410")).toMatchObject({ kind: "revenue", amount: 8 });
    expect(components.every((c) => c.amount >= 0)).toBe(true);
  });
});

describe("exclusions and tie-out", () => {
  it("never emits a facilitator-tax line", () => {
    const { components } = componentsFor(REAL);
    expect(find(components, "2230")).toBeUndefined();
  });

  it("ties the component total to the real deposit", () => {
    const { summary, components } = componentsFor(REAL);
    expect(summary.net).toBe(19.99);
    // This is the invariant the settlement-date model depends on: the invoice
    // total IS the bank line.
    expect(signedTotal(components)).toBe(19.99);
  });

  it("emits an explicit plug for the excluded remainder", () => {
    const { components } = componentsFor(REAL);
    const plug = components.find((c) => c.description.includes("Settlement adjustment"));
    expect(plug).toBeDefined();
    // The micro deposit is excluded from revenue/fees but is part of the
    // deposit; without the plug the invoice would exceed the bank line.
    expect(plug!.amount).toBe(0.01);
    expect(plug!.kind).toBe("contra");
  });

  it("emits no plug when the mapped lines already tie", () => {
    const { components } = componentsFor([
      row("Order", "ItemPrice", "Principal", 100),
      row("Order", "ItemFees", "Commission", -15),
    ]);
    expect(components.some((c) => c.description.includes("Settlement adjustment"))).toBe(false);
    expect(signedTotal(components)).toBe(85);
  });
});

describe("end to end through buildSettlementInvoice", () => {
  function invoiceFor(rows: SettlementRowInput[]) {
    const { summary, components } = componentsFor(rows);
    return buildSettlementInvoice({
      channel: "amazon",
      contactName: "Amazon",
      invoiceNumber: `AMZN-${summary.settlementId}`,
      reference: `Amazon settlement ${summary.settlementId}`,
      date: "2026-07-06",
      netPayout: summary.net,
      components,
      tracking: null,
    });
  }

  it("produces an invoice whose total equals the deposit, with no delta", () => {
    const built = invoiceFor(REAL);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.total).toBe(19.99);
    expect(built.delta).toBe(0);
  });

  it("signs revenue lines positive and contra lines negative", () => {
    const built = invoiceFor(REAL);
    if (!built.ok) return;
    const line = (code: string) => built.payload.LineItems.find((l) => l.AccountCode === code)!;
    expect(line("4010").UnitAmount).toBe(1652);      // revenue
    expect(line("4310").UnitAmount).toBe(-1178.99);  // contra
    expect(line("5470").UnitAmount).toBe(-205.32);   // contra
  });

  it("uses the AMZN- invoice number as the idempotency key", () => {
    const built = invoiceFor(REAL);
    if (!built.ok) return;
    expect(built.payload.InvoiceNumber).toBe("AMZN-26505809821");
    expect(built.payload.Type).toBe("ACCREC");
  });

  it("supports DRAFT for a first live run", () => {
    const { summary, components } = componentsFor(REAL);
    const built = buildSettlementInvoice({
      channel: "amazon", contactName: "Amazon",
      invoiceNumber: "AMZN-x", reference: "r", date: "2026-07-06",
      netPayout: summary.net, components, tracking: null, status: "DRAFT",
    });
    if (!built.ok) return;
    expect(built.payload.Status).toBe("DRAFT");
  });

  it("attaches tracking to every line when configured", () => {
    const { summary, components } = componentsFor(REAL);
    const built = buildSettlementInvoice({
      channel: "amazon", contactName: "Amazon",
      invoiceNumber: "AMZN-x", reference: "r", date: "2026-07-06",
      netPayout: summary.net, components,
      tracking: { trackingCategoryId: "tc", trackingCategoryName: "Sales Channel", trackingOptionId: "to", trackingOptionName: "Amazon" },
    });
    if (!built.ok) return;
    expect(built.payload.LineItems.every((l) => l.Tracking?.[0]?.Option === "Amazon")).toBe(true);
  });
});
