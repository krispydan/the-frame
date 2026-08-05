/**
 * Dashboard time series.
 *
 * Three judgements here are worth more than the arithmetic:
 *
 *   - a YoY line is emitted only when a prior year exists, because an empty
 *     one reads as "we collapsed" rather than "we did not exist yet";
 *   - a "4-week average" is null until there are four weeks, since the same
 *     label over two weeks is a different statistic;
 *   - a column with almost no spread is left unshaded rather than painted,
 *     because a heatmap over two distinct values invents a signal.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import {
  buildAmazonDashboardSeries,
  percentileRanks,
} from "@/modules/integrations/lib/amazon/dashboard-series";

let sqlite: ReturnType<typeof getTestDb>;
const TODAY = "2026-08-04";

beforeEach(() => {
  sqlite = getTestDb();
  resetTestDb();
});

function sale(opts: { date: string; price: number; discount?: number; qty?: number; order?: string }) {
  sqlite.prepare(`
    INSERT INTO amazon_order_rows
      (id, amazon_order_id, sku, quantity, item_price, item_tax,
       item_promotion_discount, ship_promotion_discount, shipping_price,
       shipping_tax, item_status, purchase_date)
    VALUES (?, ?, ?, ?, ?, 0, ?, 0, 0, 0, 'Shipped', ?)
  `).run(
    crypto.randomUUID(), opts.order ?? crypto.randomUUID(),
    `JX-${crypto.randomUUID().slice(0, 8)}`, opts.qty ?? 1, opts.price,
    opts.discount ?? 0, `${opts.date}T12:00:00Z`,
  );
}

function traffic(date: string, sessions: number, unitsOrdered: number) {
  sqlite.prepare(`
    INSERT INTO amazon_sales_traffic_daily (id, date, sessions, units_ordered)
    VALUES (?, ?, ?, ?)
  `).run(crypto.randomUUID(), date, sessions, unitsOrdered);
}

const series = (days = 90) => buildAmazonDashboardSeries({ days, today: TODAY });
const day = (d: string) => series().daily.find((x) => x.date === d)!;

describe("daily rows", () => {
  it("splits paid from giveaway", () => {
    sale({ date: "2026-08-01", price: 28, discount: 28 });
    sale({ date: "2026-08-01", price: 28 });

    expect(day("2026-08-01")).toMatchObject({
      grossSales: 56, giveaway: 28, netSales: 28, units: 2, freeUnits: 1,
    });
  });

  it("keeps a day with traffic and no sales", () => {
    // People looked and nobody bought — the most interesting day on the page,
    // and an inner join would delete it.
    traffic("2026-08-02", 400, 0);
    const d = day("2026-08-02");
    expect(d.sessions).toBe(400);
    expect(d.units).toBe(0);
    expect(d.conversionPct).toBe(0);
  });

  it("computes ASP over paid units only", () => {
    // Including giveaways would drag ASP toward zero and read as a price cut.
    sale({ date: "2026-08-01", price: 28, discount: 28 });
    sale({ date: "2026-08-01", price: 40 });
    expect(day("2026-08-01").asp).toBe(40);
  });

  it("leaves ASP null on an all-giveaway day rather than reporting zero", () => {
    sale({ date: "2026-08-01", price: 28, discount: 28 });
    expect(day("2026-08-01").asp).toBeNull();
  });

  it("leaves conversion null when sessions were never recorded", () => {
    sale({ date: "2026-08-01", price: 28 });
    expect(day("2026-08-01").conversionPct).toBeNull();
  });

  it("honours the window", () => {
    sale({ date: "2026-01-01", price: 28 });
    sale({ date: "2026-08-01", price: 28 });
    expect(series(30).daily.map((d) => d.date)).toEqual(["2026-08-01"]);
  });
});

describe("percentile ranks", () => {
  it("ranks by position, not by distance from the extremes", () => {
    // Min-max would flatten everything below a single outlier; rank does not.
    const r = percentileRanks([1, 2, 3, 1000]);
    expect(r[0]).toBeLessThan(r[1]!);
    expect(r[2]).toBeLessThan(r[3]!);
    expect(r[3]).toBeGreaterThan(0.8);
  });

  it("gives equal values the same shade", () => {
    const r = percentileRanks([5, 5, 1, 9]);
    expect(r[0]).toBe(r[1]);
  });

  it("refuses to shade a column with fewer than three distinct values", () => {
    expect(percentileRanks([4, 4, 9, 9])).toEqual([null, null, null, null]);
  });

  it("passes nulls through unshaded", () => {
    const r = percentileRanks([1, null, 5, 9]);
    expect(r[1]).toBeNull();
    expect(r[0]).not.toBeNull();
  });
});

describe("heatmap", () => {
  it("shades a column with real spread", () => {
    for (const [d, p] of [["2026-08-01", 10], ["2026-08-02", 50], ["2026-08-03", 200]] as const) {
      sale({ date: d, price: p });
    }
    const s = series();
    expect(s.heat["2026-08-03"].netSales).toBeGreaterThan(s.heat["2026-08-01"].netSales!);
  });

  it("says in the notes which columns it declined to shade", () => {
    sale({ date: "2026-08-01", price: 28 });
    expect(series().notes.join(" ")).toContain("too few distinct values");
  });
});

describe("weekly rollup", () => {
  it("groups days into Monday-start weeks", () => {
    sale({ date: "2026-08-03", price: 100 }); // Monday
    sale({ date: "2026-08-04", price: 50 });  // Tuesday
    const w = series().weekly.find((x) => x.weekStart === "2026-08-03")!;
    expect(w.netSales).toBe(150);
  });

  it("puts a Sunday in the week that began the Monday before", () => {
    sale({ date: "2026-08-02", price: 100 }); // Sunday
    expect(series().weekly[0].weekStart).toBe("2026-07-27");
  });

  it("withholds the 4-week average until four weeks exist", () => {
    // A "4-week average" over two weeks is a different statistic wearing the
    // same label.
    for (const d of ["2026-07-20", "2026-07-27"]) sale({ date: d, price: 100 });
    expect(series().weekly.every((w) => w.netSalesMa4 === null)).toBe(true);
  });

  it("computes the 4-week average once there are four", () => {
    for (const [d, p] of [
      ["2026-07-13", 100], ["2026-07-20", 200], ["2026-07-27", 300], ["2026-08-03", 400],
    ] as const) sale({ date: d, price: p });

    const last = series().weekly.find((w) => w.weekStart === "2026-08-03")!;
    expect(last.netSalesMa4).toBe(250);
  });
});

describe("year over year", () => {
  it("emits no YoY line without a prior year, and says why", () => {
    sale({ date: "2026-08-01", price: 100 });
    const s = series();
    expect(s.yoyAvailable).toBe(false);
    expect(s.weekly.every((w) => w.priorYearNetSales === null)).toBe(true);
    expect(s.notes.join(" ")).toContain("appears automatically");
  });

  it("emits it once a comparable period exists", () => {
    // 364 days before 2026-08-03 (a Monday) is 2025-08-04 — also a Monday.
    // Subtracting a calendar year would land on a Sunday and never match.
    sale({ date: "2025-08-04", price: 500 });
    sale({ date: "2026-08-04", price: 100 });

    const s = series();
    expect(s.yoyAvailable).toBe(true);
    const w = s.weekly.find((x) => x.weekStart === "2026-08-03")!;
    expect(w.priorYearNetSales).toBe(500);
  });

  it("nets giveaways out of the prior-year line too", () => {
    // Otherwise last year's Vine push shows as a collapse this year.
    sale({ date: "2025-08-04", price: 500, discount: 500 });
    sale({ date: "2026-08-04", price: 100 });
    expect(series().weekly.find((x) => x.weekStart === "2026-08-03")!.priorYearNetSales).toBe(0);
  });
});
