import { describe, it, expect } from "vitest";
import {
  buildSettlementInvoice,
  shopifyPayoutToComponents,
  fairePayoutToComponents,
  type ShopifyInvoiceAccounts,
  type FaireInvoiceAccounts,
} from "@/modules/integrations/lib/xero/settlement-invoice-builder";
import type { PayoutSummary } from "@/modules/integrations/lib/xero/payout-aggregator";

const shopAccts: ShopifyInvoiceAccounts = { sales: "4030", refunds: "4300", fees: "5400", adjustments: "5900" };
const faireAccts: FaireInvoiceAccounts = {
  sales: "4040", commission: "5450", paymentProcessing: "5455",
  shippingLabels: "5460", shippingIncome: "4060", inventoryAdjustments: "5900",
};

function wsSummary(over: Partial<PayoutSummary> = {}): PayoutSummary {
  return {
    payoutId: 12345, payoutDate: "2026-05-01", currency: "USD",
    netPayoutAmount: 950, platform: "shopify_wholesale",
    categories: [
      { category: "sales", amount: 1000, txCount: 5 },
      { category: "fees", amount: 50, txCount: 5 },
      { category: "clearing", amount: 950, txCount: 1 },
    ],
    orderIds: [1, 2], reconciliationDelta: 0, isAfterpayPayout: false, ...over,
  };
}

describe("settlement invoice builder — Shopify", () => {
  it("revenue is a positive line, fees negative, total = net payout", () => {
    const comps = shopifyPayoutToComponents(wsSummary(), shopAccts);
    const r = buildSettlementInvoice({
      channel: "shopify_wholesale", contactName: "Shopify Wholesale",
      invoiceNumber: "SHOP-WS-12345", reference: "payout 12345",
      date: "2026-05-01", netPayout: 950, components: comps,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sales = r.payload.LineItems.find((l) => l.AccountCode === "4030")!;
    const fee = r.payload.LineItems.find((l) => l.AccountCode === "5400")!;
    expect(sales.UnitAmount).toBe(1000);   // revenue → positive (CR revenue / DR AR)
    expect(fee.UnitAmount).toBe(-50);      // fee → negative (DR expense / CR AR)
    expect(r.total).toBe(950);             // invoice total = net deposit
    expect(r.delta).toBe(0);
    expect(r.warnings).toHaveLength(0);
  });

  it("the 'clearing' bucket is dropped (net is the invoice total, not a line)", () => {
    const comps = shopifyPayoutToComponents(wsSummary(), shopAccts);
    expect(comps.find((c) => c.category === "clearing")).toBeUndefined();
  });

  it("flags a delta when lines don't tie to the net payout", () => {
    const r = buildSettlementInvoice({
      channel: "shopify_wholesale", contactName: "Shopify Wholesale",
      invoiceNumber: "X", reference: "x", date: "2026-05-01",
      netPayout: 900, // wrong on purpose (lines net to 950)
      components: shopifyPayoutToComponents(wsSummary(), shopAccts),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.delta).toBe(50);
    expect(r.warnings.join()).toMatch(/≠ net payout/);
  });

  it("positive balance adjustment becomes a revenue line, negative a contra line", () => {
    const pos = shopifyPayoutToComponents(wsSummary({ categories: [{ category: "adjustments", amount: 12, txCount: 1 }] }), shopAccts);
    expect(pos[0].kind).toBe("revenue");
    const neg = shopifyPayoutToComponents(wsSummary({ categories: [{ category: "adjustments", amount: -12, txCount: 1 }] }), shopAccts);
    expect(neg[0].kind).toBe("contra");
    expect(neg[0].amount).toBe(12);
  });
});

describe("settlement invoice builder — Faire", () => {
  const base = { displayId: "ABC123", netOrderTotal: 120, commission: 18, paymentFee: 2.88, totalPayout: 99.12 };

  it("gross to 4040, commission + processing as negative lines, total = payout", () => {
    const comps = fairePayoutToComponents(base, faireAccts);
    const r = buildSettlementInvoice({
      channel: "faire", contactName: "Faire", invoiceNumber: "FAIRE-ABC123",
      reference: "order ABC123", date: "2026-05-01", netPayout: 99.12, components: comps,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.LineItems.find((l) => l.AccountCode === "4040")!.UnitAmount).toBe(120);
    expect(r.payload.LineItems.find((l) => l.AccountCode === "5450")!.UnitAmount).toBe(-18);
    expect(r.payload.LineItems.find((l) => l.AccountCode === "5455")!.UnitAmount).toBe(-2.88);
    expect(r.total).toBe(99.12);
    expect(r.delta).toBe(0);
  });

  it("positive payout anomaly → shipping-income revenue line", () => {
    const comps = fairePayoutToComponents({ ...base, totalPayout: 109.12 }, faireAccts);
    const r = buildSettlementInvoice({ channel: "faire", contactName: "Faire", invoiceNumber: "F", reference: "r", date: "2026-05-01", netPayout: 109.12, components: comps });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.payload.LineItems.find((l) => l.AccountCode === "4060")!;
    expect(d.UnitAmount).toBe(10);
    expect(r.delta).toBe(0);
  });

  it("negative payout anomaly → inventory-adjustments contra line", () => {
    const comps = fairePayoutToComponents({ ...base, totalPayout: 89.12 }, faireAccts);
    const r = buildSettlementInvoice({ channel: "faire", contactName: "Faire", invoiceNumber: "F", reference: "r", date: "2026-05-01", netPayout: 89.12, components: comps });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.payload.LineItems.find((l) => l.AccountCode === "5900")!;
    expect(d.UnitAmount).toBe(-10);
    expect(r.total).toBe(89.12);
  });

  it("ACCREC payload shape: type, contact, idempotent InvoiceNumber, NoTax", () => {
    const r = buildSettlementInvoice({ channel: "faire", contactName: "Faire", invoiceNumber: "FAIRE-ABC123", reference: "order ABC123", date: "2026-05-01", netPayout: 99.12, components: fairePayoutToComponents(base, faireAccts) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.Type).toBe("ACCREC");
    expect(r.payload.Contact.Name).toBe("Faire");
    expect(r.payload.InvoiceNumber).toBe("FAIRE-ABC123");
    expect(r.payload.LineAmountTypes).toBe("NoTax");
    expect(r.payload.Status).toBe("AUTHORISED");
  });
});
