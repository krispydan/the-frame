/**
 * Amazon raw-landing ingest tests.
 *
 * Fixtures mirror shapes actually observed on the live account — including
 * its quirks: settlement rows arrive with an empty `currency`, quantities
 * arrive as strings, and promotion rows carry negative amounts. Testing
 * against sanitised data would miss exactly the cases that break in
 * production.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import {
  ingestOrderRows,
  ingestSettlementRows,
  ingestSalesTraffic,
  ingestFbaInventory,
  markSyncRunning,
  markSyncSuccess,
  markSyncFailure,
  getSyncState,
  toInternalSku,
  isFbaSku,
  num,
  str,
} from "@/modules/integrations/lib/amazon/ingest";
import type { WindsorRow } from "@/modules/integrations/lib/windsor/client";

let sqlite: ReturnType<typeof getTestDb>;

beforeEach(() => {
  sqlite = getTestDb();
  resetTestDb();
});

const orderRow = (over: Partial<WindsorRow> = {}): WindsorRow => ({
  amazon_order_id: "111-9094194-1536224",
  sku: "JX1010-TOR-FBA",
  asin: "B0ABCDEFG",
  quantity: "1",            // Amazon returns quantity as TEXT
  item_price: 28.0,
  item_tax: 0,
  item_promotion_discount: "",
  ship_promotion_discount: "",
  shipping_price: 0,
  shipping_tax: "",
  order_status: "Pending",
  item_status: "Pending",
  fulfillment_channel: "Amazon",
  sales_channel: "Amazon.com",
  currency: "USD",
  purchase_date: "2026-07-28T11:11:23-07:00",
  last_updated_date: "2026-07-28T11:11:23-07:00",
  ship_city: "Austin",
  ship_state: "TX",
  ship_postal_code: "78701",
  ship_country: "US",
  is_business_order: "false",
  ...over,
});

const settlementRow = (over: Partial<WindsorRow> = {}): WindsorRow => ({
  settlement_id: "26505809801",
  posted_date: "2026-07-06T17:00:00-07:00",
  transaction_type: "Order",
  amount_type: "ItemPrice",
  amount_description: "Principal",
  amount: 28.0,
  currency: "",             // observed: frequently empty upstream
  sku: "JX1001-BLK-FBA",
  order_id: "111-1111111-1111111",
  quantity_purchased: 1,
  marketplace_name: "Amazon.com",
  settlement_start_date: "2026-06-22",
  settlement_end_date: "2026-07-06",
  deposit_date: "",
  total_amount: null,
  ...over,
});

describe("SKU helpers", () => {
  it("strips the -FBA suffix to reach our internal SKU", () => {
    expect(toInternalSku("JX1010-TOR-FBA")).toBe("JX1010-TOR");
    expect(toInternalSku("JX4006-BLK")).toBe("JX4006-BLK");
  });

  it("is case-insensitive on the suffix but leaves the SKU body untouched", () => {
    // catalog_skus is case-sensitive, so the body must survive verbatim.
    expect(toInternalSku("jx1010-tor-fba")).toBe("jx1010-tor");
    expect(toInternalSku("JX1010-Tor-Fba")).toBe("JX1010-Tor");
  });

  it("does not strip a mid-SKU occurrence of FBA", () => {
    expect(toInternalSku("JX-FBA-100")).toBe("JX-FBA-100");
  });

  it("identifies FBA vs merchant-fulfilled SKUs", () => {
    expect(isFbaSku("JX1010-TOR-FBA")).toBe(true);
    expect(isFbaSku("JX4006-BLK")).toBe(false);
    expect(isFbaSku(null)).toBe(false);
  });

  it("handles null/blank input", () => {
    expect(toInternalSku(null)).toBeNull();
    expect(toInternalSku("")).toBeNull();
  });
});

describe("coercion helpers", () => {
  it("treats Windsor's empty strings as zero, not NaN", () => {
    expect(num("")).toBe(0);
    expect(num(null)).toBe(0);
    expect(num("28.0")).toBe(28);
    expect(num("1,234.56")).toBe(1234.56);
    expect(num("garbage")).toBe(0);
  });

  it("collapses empty strings to null for text", () => {
    expect(str("")).toBeNull();
    expect(str("  ")).toBeNull();
    expect(str("Pending")).toBe("Pending");
  });
});

describe("ingestOrderRows", () => {
  it("lands a new row and parses the string quantity", () => {
    const res = ingestOrderRows([orderRow()]);
    expect(res).toMatchObject({ received: 1, inserted: 1, updated: 0 });

    const row = sqlite.prepare("SELECT * FROM amazon_order_rows").get() as Record<string, unknown>;
    expect(row.quantity).toBe(1);
    expect(row.item_price).toBe(28);
    expect(row.item_promotion_discount).toBe(0);
    expect(row.fulfillment_channel).toBe("Amazon");
  });

  it("is idempotent — re-ingesting the same row updates rather than duplicating", () => {
    ingestOrderRows([orderRow()]);
    const res = ingestOrderRows([orderRow()]);
    expect(res).toMatchObject({ inserted: 0, updated: 1 });
    expect((sqlite.prepare("SELECT COUNT(*) n FROM amazon_order_rows").get() as { n: number }).n).toBe(1);
  });

  it("refreshes item_status on the second pull — this is how Pending becomes Shipped", () => {
    ingestOrderRows([orderRow()]);
    ingestOrderRows([orderRow({
      item_status: "Shipped",
      order_status: "Shipped",
      last_updated_date: "2026-07-30T04:20:37-07:00",
    })]);

    const row = sqlite.prepare("SELECT * FROM amazon_order_rows").get() as Record<string, unknown>;
    expect(row.item_status).toBe("Shipped");
    expect(row.last_updated_date).toBe("2026-07-30T04:20:37-07:00");
  });

  it("keeps purchase_date when the last-update report omits it", () => {
    ingestOrderRows([orderRow()]);
    ingestOrderRows([orderRow({ purchase_date: "", item_status: "Shipped" })]);
    const row = sqlite.prepare("SELECT purchase_date FROM amazon_order_rows").get() as { purchase_date: string };
    expect(row.purchase_date).toBe("2026-07-28T11:11:23-07:00");
  });

  it("treats different SKUs on one order as separate lines", () => {
    const res = ingestOrderRows([orderRow(), orderRow({ sku: "JX2007-BLK-FBA" })]);
    expect(res.inserted).toBe(2);
  });

  it("rejects rows missing the dedup key instead of silently writing junk", () => {
    const res = ingestOrderRows([orderRow({ amazon_order_id: "" }), orderRow({ sku: "" })]);
    expect(res.inserted).toBe(0);
    expect(res.rejected).toHaveLength(2);
    expect(res.rejected[0].reason).toContain("missing");
  });

  it("preserves the raw row for later re-derivation", () => {
    ingestOrderRows([orderRow()]);
    const row = sqlite.prepare("SELECT raw_json FROM amazon_order_rows").get() as { raw_json: string };
    expect(JSON.parse(row.raw_json).asin).toBe("B0ABCDEFG");
  });
});

describe("ingestSettlementRows", () => {
  /** Total money landed — the invariant that duplicate handling must protect. */
  const sumAmounts = () =>
    (sqlite.prepare("SELECT IFNULL(SUM(amount), 0) AS s FROM amazon_settlement_rows").get() as { s: number }).s;

  it("lands a row and defaults the empty currency to USD", () => {
    const res = ingestSettlementRows([settlementRow()]);
    expect(res).toMatchObject({ inserted: 1, skipped: 0 });
    const row = sqlite.prepare("SELECT * FROM amazon_settlement_rows").get() as Record<string, unknown>;
    expect(row.currency).toBe("USD");
    expect(row.amount).toBe(28);
  });

  it("is append-only — a re-pull skips rows already held", () => {
    ingestSettlementRows([settlementRow()]);
    const res = ingestSettlementRows([settlementRow()]);
    expect(res).toMatchObject({ inserted: 0, skipped: 1 });
    expect((sqlite.prepare("SELECT COUNT(*) n FROM amazon_settlement_rows").get() as { n: number }).n).toBe(1);
  });

  it("keeps Principal and Tax on the same line as distinct rows", () => {
    // The dedup key must be wide enough that two legitimate rows sharing
    // settlement/order/sku both survive — a narrower key would silently
    // discard real money.
    const res = ingestSettlementRows([
      settlementRow({ amount_description: "Principal", amount: 28.0 }),
      settlementRow({ amount_description: "Tax", amount: 2.31 }),
    ]);
    expect(res.inserted).toBe(2);
  });

  it("keeps BOTH of two economically identical promotion rows", () => {
    // Two promotions of the same value on one item are indistinguishable to
    // the dedup key but are real, separate money. Dropping the second would
    // understate the settlement while still balancing against itself.
    const dup = () => settlementRow({ amount_type: "Promotion", amount_description: "Principal", amount: -14.0 });
    const res = ingestSettlementRows([dup(), dup()]);
    expect(res.inserted).toBe(2);
    expect(sumAmounts()).toBe(-28);
  });

  it("re-pulling a batch containing duplicates stays idempotent", () => {
    const dup = () => settlementRow({ amount_type: "Promotion", amount_description: "Principal", amount: -14.0 });
    ingestSettlementRows([dup(), dup()]);
    const res = ingestSettlementRows([dup(), dup()]);
    expect(res).toMatchObject({ inserted: 0, skipped: 2 });
    expect(sumAmounts()).toBe(-28);
  });

  it("tops up when a later pull reveals more duplicates than we held", () => {
    const dup = () => settlementRow({ amount_type: "Promotion", amount_description: "Principal", amount: -14.0 });
    ingestSettlementRows([dup()]);
    const res = ingestSettlementRows([dup(), dup(), dup()]);
    expect(res.inserted).toBe(2);
    expect(sumAmounts()).toBe(-42);
  });

  it("never deletes when a pull returns fewer rows than we hold", () => {
    const dup = () => settlementRow({ amount_type: "Promotion", amount_description: "Principal", amount: -14.0 });
    ingestSettlementRows([dup(), dup(), dup()]);
    ingestSettlementRows([dup()]);
    expect(sumAmounts()).toBe(-42);
  });

  it("distinguishes rows by amount", () => {
    const res = ingestSettlementRows([
      settlementRow({ amount: -3.54, amount_type: "ItemFees", amount_description: "FBAPerUnitFulfillmentFee" }),
      settlementRow({ amount: -0.62, amount_type: "ItemFees", amount_description: "Commission" }),
    ]);
    expect(res.inserted).toBe(2);
  });

  it("handles other-transaction rows that carry no sku or order id", () => {
    const res = ingestSettlementRows([
      settlementRow({
        transaction_type: "other-transaction",
        amount_type: "other-transaction",
        amount_description: "Subscription Fee",
        amount: -39.99,
        sku: "",
        order_id: "",
        quantity_purchased: "",
      }),
    ]);
    expect(res.inserted).toBe(1);
    const row = sqlite.prepare("SELECT sku, order_id, quantity_purchased FROM amazon_settlement_rows").get() as Record<string, unknown>;
    expect(row.sku).toBeNull();
    expect(row.quantity_purchased).toBeNull();
  });

  it("rejects rows without a settlement id", () => {
    const res = ingestSettlementRows([settlementRow({ settlement_id: "" })]);
    expect(res.inserted).toBe(0);
    expect(res.rejected).toHaveLength(1);
  });

  it("stores negative amounts verbatim — sign carries meaning", () => {
    ingestSettlementRows([settlementRow({ amount_type: "Promotion", amount: -1176.0 })]);
    const row = sqlite.prepare("SELECT amount FROM amazon_settlement_rows").get() as { amount: number };
    expect(row.amount).toBe(-1176);
  });
});

describe("ingestSalesTraffic", () => {
  const trafficRow = (over: Partial<WindsorRow> = {}): WindsorRow => ({
    date: "2026-07-05",
    salesbydate_orderedproductsales_amount: 112.0,
    salesbydate_unitsordered: 4,
    salesbydate_unitsshipped: 3,
    salesbydate_totalorderitems: 4,
    salesbydate_refundrate: 0,
    salesbydate_averagesellingprice_amount: 28.0,
    trafficbydate_sessions: 210,
    trafficbydate_pageviews: 340,
    trafficbydate_buyboxpercentage: 98.5,
    trafficbydate_unitsessionpercentage: 1.9,
    ...over,
  });

  it("lands a day", () => {
    const res = ingestSalesTraffic([trafficRow()]);
    expect(res.inserted).toBe(1);
    const row = sqlite.prepare("SELECT * FROM amazon_sales_traffic_daily").get() as Record<string, unknown>;
    expect(row.gross_sales).toBe(112);
    expect(row.sessions).toBe(210);
  });

  it("upserts on date — Amazon restates recent days and must not duplicate them", () => {
    ingestSalesTraffic([trafficRow()]);
    const res = ingestSalesTraffic([trafficRow({ salesbydate_orderedproductsales_amount: 140.0, salesbydate_unitsordered: 5 })]);
    expect(res).toMatchObject({ inserted: 0, updated: 1 });
    const row = sqlite.prepare("SELECT gross_sales, units_ordered FROM amazon_sales_traffic_daily").get() as Record<string, number>;
    expect(row.gross_sales).toBe(140);
    expect(row.units_ordered).toBe(5);
  });

  it("rejects a row with no date", () => {
    expect(ingestSalesTraffic([trafficRow({ date: "" })]).rejected).toHaveLength(1);
  });
});

describe("ingestFbaInventory", () => {
  const invRow = (over: Partial<WindsorRow> = {}): WindsorRow => ({
    sku: "JX1010-TOR-FBA",
    asin: "B0ABCDEFG",
    afn_fulfillable_quantity: 42,
    afn_inbound_working_quantity: 0,
    afn_inbound_shipped_quantity: 24,
    afn_inbound_receiving_quantity: 0,
    afn_reserved_quantity: 3,
    afn_unsellable_quantity: 1,
    afn_total_quantity: 70,
    ...over,
  });

  it("lands a snapshot and derives the internal SKU", () => {
    const res = ingestFbaInventory([invRow()], "2026-08-04");
    expect(res.inserted).toBe(1);
    const row = sqlite.prepare("SELECT * FROM amazon_fba_inventory").get() as Record<string, unknown>;
    expect(row.internal_sku).toBe("JX1010-TOR");
    expect(row.fulfillable_qty).toBe(42);
    expect(row.inbound_shipped_qty).toBe(24);
  });

  it("upserts within the same snapshot date but keeps separate days", () => {
    ingestFbaInventory([invRow()], "2026-08-04");
    expect(ingestFbaInventory([invRow({ afn_fulfillable_quantity: 40 })], "2026-08-04")).toMatchObject({ updated: 1 });
    expect(ingestFbaInventory([invRow()], "2026-08-05")).toMatchObject({ inserted: 1 });
    expect((sqlite.prepare("SELECT COUNT(*) n FROM amazon_fba_inventory").get() as { n: number }).n).toBe(2);
  });
});

describe("sync state", () => {
  it("records a successful run and clears the failure counter", () => {
    markSyncFailure("settlements", "timeout");
    markSyncSuccess("settlements", { syncedThrough: "2026-08-03", rowsIngested: 288 });

    const [state] = getSyncState("settlements");
    expect(state).toMatchObject({
      lastStatus: "ok",
      lastError: null,
      consecutiveFailures: 0,
      rowsIngested: 288,
      lastSyncedThrough: "2026-08-03",
    });
  });

  it("counts consecutive failures so alerting can be debounced", () => {
    expect(markSyncFailure("settlements", "timeout")).toBe(1);
    expect(markSyncFailure("settlements", "timeout")).toBe(2);
    expect(markSyncFailure("settlements", "timeout")).toBe(3);
  });

  it("marks a report running without destroying its last known watermark", () => {
    markSyncSuccess("orders_by_order_date", { syncedThrough: "2026-08-03", rowsIngested: 10 });
    markSyncRunning("orders_by_order_date");
    const [state] = getSyncState("orders_by_order_date");
    expect(state.lastStatus).toBe("running");
    expect(state.lastSyncedThrough).toBe("2026-08-03");
  });

  it("truncates a very long error so one bad payload cannot bloat the table", () => {
    markSyncFailure("settlements", "x".repeat(5000));
    const [state] = getSyncState("settlements");
    expect((state.lastError ?? "").length).toBeLessThanOrEqual(2000);
  });

  it("lists all reports when no name is given", () => {
    markSyncSuccess("settlements", {});
    markSyncSuccess("sales_traffic", {});
    expect(getSyncState()).toHaveLength(2);
  });
});
