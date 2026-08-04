import { describe, it, expect } from "vitest";
import { classifyLine, extractOrderCode } from "@/modules/finance/lib/faire-rec-digest";

describe("faire-rec-digest extractOrderCode", () => {
  it("pulls the order code from a bank description", () => {
    expect(extractOrderCode("Faire; Faire #U9WU93QFV5; FAIRE WHOLESALE; ORDER; Jaxy Eyewear")).toBe("U9WU93QFV5");
    expect(extractOrderCode("FAIRE WHOLESALE; Faire #9HZEUWQS8D; ORDER")).toBe("9HZEUWQS8D");
    expect(extractOrderCode("SHOPIFY TRANSFER")).toBeNull();
  });
});

describe("faire-rec-digest classifyLine", () => {
  const invoice = (amount: number) => ({ amount, xero_object_type: "invoice" });

  it("exact deposit → one-click match", () => {
    expect(classifyLine({ amount: 499.96, orderCode: "A", syncRow: invoice(499.96), hasIcBill: false, siblingAmounts: [] }))
      .toMatch(/Find & Match .* exact match/);
  });

  it("deposit above invoice → match + Receive Money delta to 5900 (the U9WU case)", () => {
    const r = classifyLine({ amount: 527.75, orderCode: "U9WU93QFV5", syncRow: invoice(499.96), hasIcBill: false, siblingAmounts: [] });
    expect(r).toMatch(/Receive Money \$27\.79/);
    expect(r).toMatch(/5900/);
  });

  it("deposit below invoice with sibling completing it → split payment (the HNBW case)", () => {
    const r = classifyLine({ amount: 52.16, orderCode: "HNBWED5PFN", syncRow: invoice(666.7), hasIcBill: false, siblingAmounts: [614.54] });
    expect(r).toMatch(/Split payment/);
    expect(r).toMatch(/614\.54/);
  });

  it("deposit below invoice without sibling → part-payment + expected remainder", () => {
    const r = classifyLine({ amount: 614.54, orderCode: "H", syncRow: invoice(666.7), hasIcBill: false, siblingAmounts: [100] });
    expect(r).toMatch(/Part-payment/);
    expect(r).toMatch(/52\.16/);
  });

  it("debit with an IC bill → match the bill", () => {
    expect(classifyLine({ amount: -30.88, orderCode: "KQ37BFCYFH", syncRow: invoice(1049.62), hasIcBill: true, siblingAmounts: [] }))
      .toMatch(/FAIRE-IC-KQ37BFCYFH/);
  });

  it("debit on a legacy (manual_journal) order → transfer to 1020, never 5900 twice", () => {
    const r = classifyLine({ amount: -61.76, orderCode: "9HZEUWQS8D", syncRow: { amount: 215.86, xero_object_type: "manual_journal" }, hasIcBill: false, siblingAmounts: [] });
    expect(r).toMatch(/1020/);
    expect(r).toMatch(/do NOT expense again/);
  });

  it("debit with no bill and no legacy journal → manual 5900 + detector flag", () => {
    expect(classifyLine({ amount: -10, orderCode: "X", syncRow: invoice(100), hasIcBill: false, siblingAmounts: [] }))
      .toMatch(/detector missed/);
  });

  it("deposit with no synced payout → wait for sync", () => {
    expect(classifyLine({ amount: 100, orderCode: "NEW", syncRow: undefined, hasIcBill: false, siblingAmounts: [] }))
      .toMatch(/not yet synced/);
  });

  it("legacy-model deposit → clearing transfer", () => {
    expect(classifyLine({ amount: 215.86, orderCode: "OLD", syncRow: { amount: 215.86, xero_object_type: "manual_journal" }, hasIcBill: false, siblingAmounts: [] }))
      .toMatch(/Transfer → 1020/);
  });
});
