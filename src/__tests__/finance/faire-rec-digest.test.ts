import { describe, it, expect } from "vitest";
import { classifyOpenInvoice, extractOrderCode } from "@/modules/finance/lib/faire-rec-digest";

describe("faire-rec-digest extractOrderCode", () => {
  it("pulls the order code from invoice + bill numbers", () => {
    expect(extractOrderCode("FAIRE-U9WU93QFV5")).toBe("U9WU93QFV5");
    expect(extractOrderCode("FAIRE-IC-KQ37BFCYFH")).toBe("KQ37BFCYFH");
    expect(extractOrderCode("SHOP-WS-12345")).toBeNull();
  });
});

describe("faire-rec-digest classifyOpenInvoice", () => {
  it("formula matches invoice → simple match instruction", () => {
    const r = classifyOpenInvoice({
      invoiceNumber: "FAIRE-ABC123XYZ9", amountDue: 246.74, ageDays: 3,
      math: { netOrderTotal: 256, commission: 0, paymentFee: 9.26, totalPayout: 246.74 },
    });
    expect(r).toMatch(/Find & Match/);
    expect(r).toMatch(/exact/);
  });

  it("formula wire ABOVE invoice → pre-writes the Receive-Money-to-5900 playbook (the U9WU case)", () => {
    const r = classifyOpenInvoice({
      invoiceNumber: "FAIRE-U9WU93QFV5", amountDue: 499.96, ageDays: 2,
      math: { netOrderTotal: 547.2, commission: 0, paymentFee: 19.45, totalPayout: 499.96 },
    });
    expect(r).toMatch(/\$527\.75/);
    expect(r).toMatch(/Receive Money \$27\.79/);
    expect(r).toMatch(/5900/);
  });

  it("formula wire BELOW invoice → part-payment playbook with expected remainder (the HNBW shape)", () => {
    const r = classifyOpenInvoice({
      invoiceNumber: "FAIRE-HNBWED5PFN", amountDue: 693.86, ageDays: 2,
      math: { netOrderTotal: 864, commission: 139.6, paymentFee: 30.54, totalPayout: 666.7 },
    });
    expect(r).toMatch(/part-pay/i);
  });

  it("no stored math → plain expected-deposit instruction", () => {
    expect(classifyOpenInvoice({ invoiceNumber: "FAIRE-NEWORDER99", amountDue: 100, ageDays: 1, math: null }))
      .toMatch(/Deposit of \$100\.00 expected/);
  });

  it("stale open invoice gets the age flag", () => {
    const r = classifyOpenInvoice({ invoiceNumber: "FAIRE-OLDORDER99", amountDue: 50, ageDays: 15, math: null });
    expect(r).toMatch(/open 15d/);
    expect(r).toMatch(/hold\/issue report/);
  });

  it("fresh invoice has no age flag", () => {
    expect(classifyOpenInvoice({ invoiceNumber: "FAIRE-FRESH12345", amountDue: 50, ageDays: 2, math: null }))
      .not.toMatch(/⏰/);
  });
});
