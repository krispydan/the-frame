/**
 * Per-ASIN traffic + listing ingest.
 *
 * Two things here are worth more than the rest:
 *
 *   - Amazon emits a parent-only summary row alongside its child rows. Storing
 *     it double-counts every metric against its own children, which inflates
 *     sessions and conversion on exactly the reports built to diagnose them.
 *   - A listing Amazon stops returning must keep its last known title. A report
 *     that suddenly shows SKU codes where product names used to be reads as a
 *     bug in the report, not as a delisted product.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import {
  ingestAsinTraffic,
  ingestListings,
  skuDisplayNames,
} from "@/modules/integrations/lib/amazon/ingest";
import type { WindsorRow } from "@/modules/integrations/lib/windsor/client";

let sqlite: ReturnType<typeof getTestDb>;

beforeEach(() => {
  sqlite = getTestDb();
  resetTestDb();
});

const trafficRow = (over: Partial<Record<string, unknown>> = {}): WindsorRow => ({
  date: "2026-07-10",
  childAsin: "B0AAA",
  parentAsin: "B0PARENT",
  "salesByAsin-unitsOrdered": 5,
  "salesByAsin-unitsShipped": 4,
  "salesByAsin-totalOrderItems": 5,
  "salesByAsin-orderedProductSales-amount": 140,
  "salesByAsin-averageSellingPrice-amount": 28,
  "salesByAsin-refundRate": 0.02,
  "trafficByAsin-sessions": 200,
  "trafficByAsin-pageViews": 260,
  "trafficByAsin-buyBoxPercentage": 98.5,
  "trafficByAsin-unitSessionPercentage": 2.5,
  "trafficByAsin-sessionPercentage": 11.1,
  ...over,
}) as WindsorRow;

const rows = () => sqlite.prepare(
  "SELECT * FROM amazon_asin_traffic_daily ORDER BY child_asin",
).all() as Array<Record<string, unknown>>;

describe("per-ASIN traffic", () => {
  it("lands a row per ASIN per day", () => {
    const r = ingestAsinTraffic([trafficRow(), trafficRow({ childAsin: "B0BBB" })]);
    expect(r.inserted).toBe(2);
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toMatchObject({
      child_asin: "B0AAA", parent_asin: "B0PARENT",
      units_ordered: 5, sessions: 200, conversion_rate: 2.5, buy_box_pct: 98.5,
    });
  });

  it("rejects the parent-only summary row rather than storing it", () => {
    // Amazon sends this alongside the child rows; keeping it would double
    // every metric against its own children.
    const r = ingestAsinTraffic([trafficRow({ childAsin: null })]);
    expect(r.inserted).toBe(0);
    expect(r.rejected[0].reason).toBe("missing childAsin");
    expect(rows()).toHaveLength(0);
  });

  it("rejects a row with no date", () => {
    const r = ingestAsinTraffic([trafficRow({ date: null })]);
    expect(r.rejected[0].reason).toBe("missing date");
  });

  it("restates a day rather than duplicating it", () => {
    // Amazon revises recent days as orders settle and sessions dedupe.
    ingestAsinTraffic([trafficRow()]);
    const second = ingestAsinTraffic([trafficRow({ "trafficByAsin-sessions": 240, "salesByAsin-unitsOrdered": 7 })]);

    expect(second.updated).toBe(1);
    expect(second.inserted).toBe(0);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ sessions: 240, units_ordered: 7 });
  });

  it("keeps the same ASIN on different days apart", () => {
    ingestAsinTraffic([trafficRow(), trafficRow({ date: "2026-07-11" })]);
    expect(rows()).toHaveLength(2);
  });

  it("coerces Windsor's empty strings to zero rather than null", () => {
    ingestAsinTraffic([trafficRow({ "trafficByAsin-sessions": "", "salesByAsin-unitsOrdered": "" })]);
    expect(rows()[0]).toMatchObject({ sessions: 0, units_ordered: 0 });
  });

  it("truncates fractional unit counts", () => {
    ingestAsinTraffic([trafficRow({ "salesByAsin-unitsOrdered": 5.9 })]);
    expect(rows()[0].units_ordered).toBe(5);
  });
});

const listingRow = (over: Partial<Record<string, unknown>> = {}): WindsorRow => ({
  "seller-sku": "JX3004-S-BLK",
  asin1: "B0AAA",
  "item-name": "Aviator Sunglasses — Black",
  price: 28,
  quantity: 40,
  status: "Active",
  "fulfillment-channel": "DEFAULT",
  "open-date": "2026-06-01",
  ...over,
}) as WindsorRow;

const listings = () => sqlite.prepare(
  "SELECT * FROM amazon_listings ORDER BY sku",
).all() as Array<Record<string, unknown>>;

describe("listings", () => {
  it("lands a listing and resolves the internal SKU", () => {
    ingestListings([listingRow(), listingRow({ "seller-sku": "JX3004-S-BLK-FBA" })]);
    const l = listings();
    expect(l).toHaveLength(2);
    // Both spellings resolve to the one internal SKU, so downstream joins
    // never have to know about the suffix.
    expect(l.map((x) => x.internal_sku)).toEqual(["JX3004-S-BLK", "JX3004-S-BLK"]);
  });

  it("rejects a row with no seller SKU", () => {
    const r = ingestListings([listingRow({ "seller-sku": null })]);
    expect(r.rejected[0].reason).toBe("missing seller-sku");
  });

  it("updates an existing listing in place", () => {
    ingestListings([listingRow()]);
    const r = ingestListings([listingRow({ "item-name": "Aviator Sunglasses — Matte Black", price: 32 })]);
    expect(r.updated).toBe(1);
    expect(listings()).toHaveLength(1);
    expect(listings()[0]).toMatchObject({ title: "Aviator Sunglasses — Matte Black", price: 32 });
  });

  it("keeps the last known title for a listing Amazon stops returning", () => {
    ingestListings([listingRow(), listingRow({ "seller-sku": "JX9-GONE", "item-name": "Discontinued" })]);
    ingestListings([listingRow()]); // JX9-GONE absent from this pull
    expect(listings()).toHaveLength(2);
    expect(listings().find((l) => l.sku === "JX9-GONE")!.title).toBe("Discontinued");
  });
});

describe("display names", () => {
  function catalogSku(sku: string, product: string, color: string | null) {
    sqlite.prepare(
      "INSERT OR IGNORE INTO catalog_products (id, name, created_at) VALUES ('p-1', ?, datetime('now'))",
    ).run(product);
    sqlite.prepare(
      "INSERT INTO catalog_skus (id, product_id, sku, color_name) VALUES (?, 'p-1', ?, ?)",
    ).run(`s-${sku}`, sku, color);
  }

  it("falls back to Amazon's title when the catalog has no name", () => {
    ingestListings([listingRow()]);
    expect(skuDisplayNames().get("JX3004-S-BLK")).toBe("Aviator Sunglasses — Black");
  });

  it("prefers our curated catalog name over Amazon's keyword-stuffed title", () => {
    ingestListings([listingRow()]);
    catalogSku("JX3004-S-BLK", "Aviator", "Black");
    expect(skuDisplayNames().get("JX3004-S-BLK")).toBe("Aviator · Black");
  });

  it("omits the colour separator when there is no colour", () => {
    catalogSku("JX-PLAIN", "Reader", null);
    expect(skuDisplayNames().get("JX-PLAIN")).toBe("Reader");
  });

  it("returns nothing for a SKU neither source names", () => {
    expect(skuDisplayNames().get("JX-UNKNOWN")).toBeUndefined();
  });
});
