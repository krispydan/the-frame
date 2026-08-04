/**
 * Settlement bridge tests.
 *
 * The bridge is what makes Amazon visible to reconciliation and revenue
 * recognition, so the join key and the open/closed rule are the things worth
 * pinning: a wrong key silently orphans a settlement, and bridging an open
 * settlement produces figures that shift under an already-posted journal.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import {
  bridgeAmazonSettlements,
  isSettlementClosed,
  amazonSettlementExternalId,
} from "@/modules/integrations/lib/amazon/settlement-bridge";

let sqlite: ReturnType<typeof getTestDb>;

beforeEach(() => {
  sqlite = getTestDb();
  resetTestDb();
});

function settlementRow(over: Record<string, unknown> = {}) {
  const r = {
    settlement_id: "26505809821",
    posted_date: "2026-07-06",
    transaction_type: "Order",
    amount_type: "ItemPrice",
    amount_description: "Principal",
    amount: 28.0,
    currency: "USD",
    sku: "JX1001-BLK-FBA",
    order_id: "111-1111111-1111111",
    settlement_start_date: "2026-06-22",
    settlement_end_date: "2026-07-06",
    deposit_date: "2026-07-08",
    total_amount: null,
    ...over,
  };
  sqlite.prepare(`
    INSERT INTO amazon_settlement_rows (
      id, settlement_id, posted_date, transaction_type, amount_type, amount_description,
      amount, currency, sku, order_id, settlement_start_date, settlement_end_date,
      deposit_date, total_amount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(), r.settlement_id, r.posted_date, r.transaction_type, r.amount_type,
    r.amount_description, r.amount, r.currency, r.sku, r.order_id,
    r.settlement_start_date, r.settlement_end_date, r.deposit_date, r.total_amount,
  );
  return r;
}

const TODAY = "2026-08-04";
const getSettlement = () =>
  sqlite.prepare("SELECT * FROM settlements WHERE channel='amazon' LIMIT 1").get() as Record<string, unknown>;
const lineItems = () =>
  sqlite.prepare("SELECT * FROM settlement_line_items ORDER BY type, description").all() as Array<Record<string, unknown>>;

describe("isSettlementClosed", () => {
  it("treats a long-past period end as closed", () => {
    expect(isSettlementClosed("2026-07-06", TODAY)).toBe(true);
  });

  it("treats a future period end as open — Amazon is still adding lines", () => {
    expect(isSettlementClosed("2026-08-20", TODAY)).toBe(false);
  });

  it("holds a settlement open until it has been quiet for a couple of days", () => {
    // Guards against bridging a settlement Amazon is still writing to, which
    // would produce figures that shift under an already-posted journal.
    expect(isSettlementClosed(TODAY, TODAY)).toBe(false);
    expect(isSettlementClosed("2026-08-03", TODAY)).toBe(false);
    expect(isSettlementClosed("2026-08-02", TODAY)).toBe(true);
  });

  it("treats a missing period end as open", () => {
    expect(isSettlementClosed(null, TODAY)).toBe(false);
  });
});

describe("period derivation when Amazon's header dates are empty", () => {
  it("derives the period from posted_date, which is how the live data actually arrives", () => {
    // Verified against all 288 rows on the live account: Windsor returns
    // settlement_start_date, settlement_end_date and deposit_date empty.
    // Keying the close check on the end date left every settlement
    // permanently "open", silently blocking the bridge and all Xero posting.
    settlementRow({ settlement_start_date: "", settlement_end_date: "", deposit_date: "", posted_date: "2026-06-22", amount: 100 });
    settlementRow({ settlement_start_date: "", settlement_end_date: "", deposit_date: "", posted_date: "2026-07-06", amount: 50, sku: "JX2-BLK-FBA" });

    const res = bridgeAmazonSettlements({ today: TODAY });
    expect(res.created).toBe(1);
    expect(res.skippedOpen).toBe(0);

    const s = getSettlement();
    expect(s.period_start).toBe("2026-06-22");
    expect(s.period_end).toBe("2026-07-06");
  });

  it("still holds a recently-active settlement open even with no header dates", () => {
    settlementRow({ settlement_start_date: "", settlement_end_date: "", posted_date: TODAY });
    expect(bridgeAmazonSettlements({ today: TODAY }).skippedOpen).toBe(1);
  });

  it("prefers Amazon's header dates when it does supply them", () => {
    settlementRow({ settlement_start_date: "2026-06-01", settlement_end_date: "2026-06-15", posted_date: "2026-06-10" });
    bridgeAmazonSettlements({ today: TODAY });
    const s = getSettlement();
    expect(s.period_start).toBe("2026-06-01");
    expect(s.period_end).toBe("2026-06-15");
  });
});

describe("bridgeAmazonSettlements", () => {
  it("creates a settlement row with the derived totals", () => {
    settlementRow({ amount: 952.0 });
    settlementRow({ amount_type: "Promotion", amount: -786.99, order_id: null });
    settlementRow({ amount_type: "ItemFees", amount_description: "Commission", amount: -20.0, order_id: null });

    const res = bridgeAmazonSettlements({ today: TODAY });
    expect(res.created).toBe(1);

    const s = getSettlement();
    expect(s.channel).toBe("amazon");
    expect(s.external_id).toBe("amazon_settlement_26505809821");
    expect(s.gross_amount).toBe(952);
    expect(s.fees).toBe(20);
    expect(s.status).toBe("received");
    expect(s.period_end).toBe("2026-07-06");
  });

  it("skips an open settlement rather than bridging a moving target", () => {
    settlementRow({ settlement_end_date: "2026-08-20" });
    const res = bridgeAmazonSettlements({ today: TODAY });
    expect(res).toMatchObject({ created: 0, skippedOpen: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) n FROM settlements").get()).toMatchObject({ n: 0 });
  });

  it("links sale lines to local orders through the prefixed external id", () => {
    // The prefix is what lets the reconciliation view's dual-key join
    // (o.id = sli.order_id OR o.external_id = sli.order_id) find the order.
    settlementRow({ order_id: "111-2222222-3333333", amount: 56.0 });
    bridgeAmazonSettlements({ today: TODAY });

    const sale = lineItems().find((l) => l.type === "sale")!;
    expect(sale.order_id).toBe("amazon:111-2222222-3333333");
    expect(sale.amount).toBe(56);
  });

  it("aggregates several rows for one order into a single sale line", () => {
    settlementRow({ order_id: "111-A", amount: 28.0 });
    settlementRow({ order_id: "111-A", amount: 28.0, sku: "JX2-BLK-FBA" });
    bridgeAmazonSettlements({ today: TODAY });

    const sales = lineItems().filter((l) => l.type === "sale");
    expect(sales).toHaveLength(1);
    expect(sales[0].amount).toBe(56);
  });

  it("collapses non-sale rows into one readable line per category", () => {
    settlementRow({ amount: 100 });
    settlementRow({ amount_type: "ItemFees", amount_description: "Commission", amount: -5, order_id: null });
    settlementRow({ amount_type: "ItemFees", amount_description: "Commission", amount: -3, order_id: null });
    settlementRow({ amount_type: "ItemFees", amount_description: "FBAPerUnitFulfillmentFee", amount: -7, order_id: null });
    bridgeAmazonSettlements({ today: TODAY });

    const fees = lineItems().filter((l) => l.type === "fee");
    // A bank deposit is checked against a few figures, not every raw row.
    expect(fees.map((f) => f.description).sort()).toEqual(["FBA fulfilment fees", "Referral commission"]);
    expect(fees.find((f) => f.description === "Referral commission")!.amount).toBe(-8);
  });

  it("is idempotent — re-bridging updates in place and rebuilds line items", () => {
    settlementRow({ amount: 100 });
    bridgeAmazonSettlements({ today: TODAY });
    const first = lineItems().length;

    const res = bridgeAmazonSettlements({ today: TODAY });
    expect(res).toMatchObject({ created: 0, updated: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) n FROM settlements").get()).toMatchObject({ n: 1 });
    expect(lineItems()).toHaveLength(first); // rebuilt, not duplicated
  });

  it("reports unclassified lines so they can be alerted on", () => {
    settlementRow({ amount: 100 });
    settlementRow({
      transaction_type: "other-transaction", amount_type: "other-transaction",
      amount_description: "Brand New Amazon Fee", amount: -12, order_id: null,
    });

    const res = bridgeAmazonSettlements({ today: TODAY });
    expect(res.unclassified).toHaveLength(1);
    expect(res.unclassified[0]).toMatchObject({ settlementId: "26505809821", amount: -12 });
  });

  it("reports a non-zero facilitator-tax residual", () => {
    settlementRow({ amount_description: "Tax", amount: 10, order_id: null });
    settlementRow({ amount_type: "ItemWithheldTax", amount_description: "MarketplaceFacilitatorTax-Principal", amount: -7, order_id: null });

    const res = bridgeAmazonSettlements({ today: TODAY });
    expect(res.taxResiduals).toEqual([{ settlementId: "26505809821", residual: 3 }]);
  });

  it("does not report a residual when the tax legs cancel", () => {
    settlementRow({ amount_description: "Tax", amount: 10, order_id: null });
    settlementRow({ amount_type: "ItemWithheldTax", amount_description: "MarketplaceFacilitatorTax-Principal", amount: -10, order_id: null });
    expect(bridgeAmazonSettlements({ today: TODAY }).taxResiduals).toEqual([]);
  });

  it("bridges several settlements independently", () => {
    settlementRow({ settlement_id: "A", amount: 100 });
    settlementRow({ settlement_id: "B", amount: 200 });
    const res = bridgeAmazonSettlements({ today: TODAY });
    expect(res.created).toBe(2);
  });

  it("can target a single settlement", () => {
    settlementRow({ settlement_id: "A", amount: 100 });
    settlementRow({ settlement_id: "B", amount: 200 });
    const res = bridgeAmazonSettlements({ today: TODAY, settlementIds: ["B"] });
    expect(res.created).toBe(1);
    expect(getSettlement().external_id).toBe(amazonSettlementExternalId("B"));
  });

  it("carries the settlement net through as net_amount, which must tie to the deposit", () => {
    settlementRow({ amount: 100 });
    settlementRow({ amount_type: "ItemFees", amount_description: "Commission", amount: -8, order_id: null });
    settlementRow({ amount_type: "Promotion", amount: -20, order_id: null });
    bridgeAmazonSettlements({ today: TODAY });
    expect(getSettlement().net_amount).toBe(72);
  });
});
