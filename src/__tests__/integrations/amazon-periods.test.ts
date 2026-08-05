/**
 * Reporting period selection.
 *
 * Month columns must be contiguous. Deriving them from "months that have
 * data" drops a quiet month out of the middle, so a table reading "Jun | Aug"
 * looks like two consecutive months and any trend computed across it is wrong
 * by a whole period. That is the bug these pin down.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import { recentAmazonMonths, monthBounds } from "@/modules/integrations/lib/amazon/periods";

let sqlite: ReturnType<typeof getTestDb>;

beforeEach(() => {
  sqlite = getTestDb();
  resetTestDb();
});

function sale(date: string) {
  sqlite.prepare(`
    INSERT INTO amazon_order_rows
      (id, amazon_order_id, sku, quantity, item_price, item_promotion_discount, purchase_date)
    VALUES (?, ?, 'JX1', 1, 28, 0, ?)
  `).run(crypto.randomUUID(), crypto.randomUUID(), `${date}T12:00:00Z`);
}

describe("recentAmazonMonths", () => {
  it("fills a gap month rather than skipping it", () => {
    sale("2026-06-05");
    sale("2026-08-05");
    expect(recentAmazonMonths(3)).toEqual(["2026-06", "2026-07", "2026-08"]);
  });

  it("anchors on the latest month with data, not on today", () => {
    // A report run on the 1st should not lead with an empty current month.
    sale("2026-06-05");
    expect(recentAmazonMonths(3)).toEqual(["2026-06"]);
  });

  it("never invents months before the account existed", () => {
    // An empty column there says "we sold nothing" when the truth is "we had
    // not started".
    sale("2026-07-05");
    expect(recentAmazonMonths(12)).toEqual(["2026-07"]);
  });

  it("returns oldest first", () => {
    sale("2026-06-05");
    sale("2026-07-05");
    expect(recentAmazonMonths(2)).toEqual(["2026-06", "2026-07"]);
  });

  it("honours the count", () => {
    for (const m of ["2026-04", "2026-05", "2026-06", "2026-07"]) sale(`${m}-05`);
    expect(recentAmazonMonths(2)).toEqual(["2026-06", "2026-07"]);
  });

  it("crosses a year boundary", () => {
    sale("2025-12-05");
    sale("2026-01-05");
    expect(recentAmazonMonths(2)).toEqual(["2025-12", "2026-01"]);
  });

  it("returns nothing when there is no activity", () => {
    expect(recentAmazonMonths(3)).toEqual([]);
  });
});

describe("monthBounds", () => {
  it("covers the whole month including the last day", () => {
    expect(monthBounds("2026-07")).toEqual({ start: "2026-07-01", end: "2026-07-31" });
  });

  it("handles February in a non-leap year", () => {
    expect(monthBounds("2026-02").end).toBe("2026-02-28");
  });

  it("handles February in a leap year", () => {
    expect(monthBounds("2028-02").end).toBe("2028-02-29");
  });
});
