/**
 * Settlement classifier tests.
 *
 * The first block asserts the COMPLETE taxonomy observed on the live account
 * across 288 settlement rows (4 Jun – 25 Jul 2026). If a future change
 * re-routes any of these, real money moves to a different account and this
 * fails immediately.
 *
 * Pure functions: no DB, no mocks — the pattern this repo already uses for
 * settlement-invoice-builder.
 */

import { describe, it, expect } from "vitest";
import {
  classifySettlementRow,
  summariseSettlement,
  type SettlementRowInput,
} from "@/modules/integrations/lib/amazon/settlement-classify";

const row = (
  transactionType: string, amountType: string, amountDescription: string, amount = 1,
): SettlementRowInput => ({ transactionType, amountType, amountDescription, amount });

describe("the complete observed taxonomy (288 real settlement rows)", () => {
  // [transaction_type, amount_type, amount_description, expected category]
  const OBSERVED: Array<[string, string, string, string]> = [
    ["Order", "ItemPrice", "Principal", "sales"],
    ["Order", "ItemPrice", "Tax", "tax_collected"],
    ["Order", "ItemPrice", "Shipping", "shipping_income"],
    ["Order", "ItemWithheldTax", "MarketplaceFacilitatorTax-Principal", "tax_withheld"],
    ["Order", "Promotion", "Principal", "discounts"],
    ["Order", "Promotion", "Shipping", "discounts"],
    ["Order", "ItemFees", "Commission", "commission"],
    ["Order", "ItemFees", "FBAPerUnitFulfillmentFee", "fba_fulfillment"],
    ["Refund", "ItemPrice", "Principal", "refunds"],
    ["Refund", "ItemPrice", "Tax", "tax_collected"],
    ["Refund", "ItemWithheldTax", "MarketplaceFacilitatorTax-Principal", "tax_withheld"],
    ["Refund", "ItemFees", "Commission", "commission"],
    ["Refund", "ItemFees", "RefundCommission", "commission"],
    ["FBAFees", "FBA Amazon-Partnered Carrier Shipment Fee", "Base fee", "inbound_freight"],
    ["FBAFees", "FBA Amazon-Partnered Carrier Shipment Fee", "Discount on Fee", "inbound_freight"],
    ["FBAFees", "FBA Inventory Storage Fee", "Base fee", "fba_storage"],
    ["other-transaction", "other-transaction", "Subscription Fee", "subscription"],
    ["other-transaction", "other-transaction", "Inbound Transportation Fee", "inbound_freight"],
    ["other-transaction", "other-transaction", "Shipping label purchase for return", "outbound_shipping"],
    ["other-transaction", "other-transaction", "Payable to Amazon", "clearing"],
    ["other-transaction", "other-transaction", "Successful charge", "clearing"],
    ["Transfers", "Micro Deposit", "Micro Deposit", "clearing"],
  ];

  for (const [tx, type, desc, expected] of OBSERVED) {
    it(`${tx} / ${type} / ${desc} → ${expected}`, () => {
      expect(classifySettlementRow(row(tx, type, desc)).category).toBe(expected);
    });
  }

  it("classifies every observed combination — none fall through to unclassified", () => {
    const unknown = OBSERVED.filter(([tx, t, d]) => classifySettlementRow(row(tx, t, d)).isUnknown);
    expect(unknown).toEqual([]);
  });
});

describe("unknown handling", () => {
  it("flags an unrecognised fee rather than guessing a bucket", () => {
    // Amazon will introduce fee types we have not seen. The failure mode we
    // refuse is one where they quietly land in whatever matched a substring.
    const c = classifySettlementRow(row("other-transaction", "other-transaction", "Vine Enrollment Fee"));
    expect(c.isUnknown).toBe(true);
    expect(c.category).toBe("unclassified");
    expect(c.reason).toContain("Vine Enrollment Fee");
  });

  it("flags a completely novel transaction type", () => {
    expect(classifySettlementRow(row("SomethingNew", "Whatever", "Mystery")).isUnknown).toBe(true);
  });

  it("handles null/blank columns without throwing", () => {
    const c = classifySettlementRow({ transactionType: null, amountType: null, amountDescription: null, amount: 0 });
    expect(c.isUnknown).toBe(true);
  });

  it("is case-insensitive, since Amazon's casing is not guaranteed", () => {
    expect(classifySettlementRow(row("ORDER", "itemprice", "PRINCIPAL")).category).toBe("sales");
  });
});

describe("refund vs order disambiguation", () => {
  it("routes identical Principal rows differently by transaction type", () => {
    expect(classifySettlementRow(row("Order", "ItemPrice", "Principal")).category).toBe("sales");
    expect(classifySettlementRow(row("Refund", "ItemPrice", "Principal")).category).toBe("refunds");
  });
});

describe("summariseSettlement", () => {
  /** The real 4 Jun – 25 Jul totals, condensed to one row per line type. */
  const realish: SettlementRowInput[] = [
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
    row("FBAFees", "FBA Inventory Storage Fee", "Base fee", 0),
  ];

  it("reproduces the real net settlement figure", () => {
    // The whole period netted $19.99 — this is the number that must tie to
    // the bank.
    expect(summariseSettlement("26505809801", realish).net).toBe(19.99);
  });

  it("separates gross sales from promotions rather than netting them", () => {
    const s = summariseSettlement("s1", realish);
    expect(s.grossSales).toBe(1652);
    expect(s.promotions).toBe(1178.99); // principal + shipping promos
    // Promotions ran at ~71% of gross during launch. Netting them would hide
    // the single most important fact about this channel's economics.
    expect(s.promotions / s.grossSales).toBeGreaterThan(0.7);
  });

  it("nets the facilitator tax legs to exactly zero", () => {
    expect(summariseSettlement("s1", realish).taxResidual).toBe(0);
  });

  it("surfaces a non-zero tax residual instead of silently absorbing it", () => {
    const s = summariseSettlement("s1", [
      row("Order", "ItemPrice", "Tax", 10),
      row("Order", "ItemWithheldTax", "MarketplaceFacilitatorTax-Principal", -7),
    ]);
    // Netting is only safe while the legs cancel; if Amazon changes that we
    // want an alert, not an invisible imbalance.
    expect(s.taxResidual).toBe(3);
  });

  it("totals fees as a positive magnitude", () => {
    const s = summariseSettlement("s1", realish);
    // 205.32 + 36.40 + 1.12 - 5.60(credit) + 79.98 + 21.30 + 5.48 + 0(partnered nets) ...
    expect(s.totalFees).toBeGreaterThan(300);
  });

  it("reports refunds as a positive magnitude", () => {
    expect(summariseSettlement("s1", realish).refunds).toBe(112);
  });

  it("nets the offsetting negative-balance charge pair to zero", () => {
    const s = summariseSettlement("s1", realish);
    expect(s.byCategory.clearing).toBe(-0.01); // only the micro deposit survives
  });

  it("collects unclassified lines for alerting", () => {
    const s = summariseSettlement("s1", [
      row("Order", "ItemPrice", "Principal", 100),
      row("other-transaction", "other-transaction", "Brand New Fee", -5),
    ]);
    expect(s.unclassified).toHaveLength(1);
    expect(s.unclassified[0].amount).toBe(-5);
  });

  it("handles an empty settlement without dividing by zero", () => {
    const s = summariseSettlement("s1", []);
    expect(s).toMatchObject({ net: 0, grossSales: 0, promotions: 0, totalFees: 0, lineCount: 0 });
  });
});
