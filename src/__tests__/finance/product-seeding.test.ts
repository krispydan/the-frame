/**
 * Product seeding — routing the cost of giveaways out of COGS.
 *
 * Amazon Vine units and influencer gifting ship for no consideration. They are
 * marketing spend, not cost of sales, and lumping them into COGS understates
 * gross margin on what actually sold.
 *
 * Two things have to hold or this is worse than not doing it:
 *   - the split must be a SUBSET of the channel total, so the journal still
 *     balances against the same inventory credit;
 *   - with no seeding account configured, behaviour must be byte-identical to
 *     before, so this is safe to deploy before the account exists in Xero.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import { calculateCogs } from "@/modules/finance/lib/fifo-engine";
import { buildDailyCogsJournal } from "@/modules/finance/lib/daily-cogs";

let sqlite: ReturnType<typeof getTestDb>;
const DAY = "2026-07-10";

beforeEach(() => {
  sqlite = getTestDb();
  resetTestDb();
});

function setSeedingAccount(code: string | null) {
  sqlite.prepare("DELETE FROM settings WHERE key = 'product_seeding_account'").run();
  if (code) {
    sqlite.prepare("INSERT INTO settings (key, value) VALUES ('product_seeding_account', ?)").run(code);
  }
}

/** One shipped line + its FIFO depletion. `discount` drives the seeding split. */
function line(opts: {
  id: string; channel: string; qty: number; price: number; discount: number;
  unitCost?: number; freight?: number; duties?: number;
}) {
  const unitCost = opts.unitCost ?? 5;
  sqlite.prepare(`
    INSERT INTO orders (id, order_number, channel, status, total, placed_at, shipped_at, created_at)
    VALUES (?, ?, ?, 'shipped', 0, ?, ?, datetime('now'))
  `).run(opts.id, `O-${opts.id}`, opts.channel, `${DAY}T00:00:00Z`, `${DAY}T00:00:00Z`);

  sqlite.prepare(`
    INSERT INTO order_items (id, order_id, sku, sku_id, product_name, quantity, unit_price, total_price, discount)
    VALUES (?, ?, 'JX1-BLK', 'sku-1', 'x', ?, ?, ?, ?)
  `).run(`oi-${opts.id}`, opts.id, opts.qty, opts.price / opts.qty, opts.price, opts.discount);

  sqlite.prepare(`
    INSERT INTO inventory_cost_layers
      (id, sku_id, quantity, remaining_quantity, unit_cost, freight_per_unit, duties_per_unit, landed_cost_per_unit, received_at)
    VALUES (?, 'sku-1', 1000, 900, ?, ?, ?, ?, '2026-06-01')
  `).run(`l-${opts.id}`, unitCost, opts.freight ?? 1, opts.duties ?? 0.5,
    unitCost + (opts.freight ?? 1) + (opts.duties ?? 0.5));

  sqlite.prepare(`
    INSERT INTO inventory_cost_depletions
      (id, cost_layer_id, order_item_id, order_id, channel, quantity, unit_cost, landed_cost_per_unit, depleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), `l-${opts.id}`, `oi-${opts.id}`, opts.id, opts.channel,
    opts.qty, unitCost, unitCost + (opts.freight ?? 1) + (opts.duties ?? 0.5), `${DAY}T12:00:00Z`);
}

const calc = () => calculateCogs(DAY, DAY);

describe("the split", () => {
  it("marks a fully discounted line as seeded", () => {
    line({ id: "o1", channel: "amazon", qty: 2, price: 56, discount: 56 });
    const b = calc().channelBreakdown.amazon;
    expect(b.units).toBe(2);
    expect(b.seeded.units).toBe(2);
    expect(b.seeded.productCost).toBe(10);
  });

  it("leaves a paid line out of the seeded slice", () => {
    line({ id: "o1", channel: "amazon", qty: 2, price: 56, discount: 0 });
    const b = calc().channelBreakdown.amazon;
    expect(b.units).toBe(2);
    expect(b.seeded.units).toBe(0);
    expect(b.seeded.totalCogs).toBe(0);
  });

  it("does not treat a partly discounted line as a giveaway", () => {
    // Half off is still a sale. Only zero consideration is seeding.
    line({ id: "o1", channel: "amazon", qty: 2, price: 56, discount: 28 });
    expect(calc().channelBreakdown.amazon.seeded.units).toBe(0);
  });

  it("keeps seeded as a subset of the channel total", () => {
    line({ id: "o1", channel: "amazon", qty: 2, price: 56, discount: 56 });
    line({ id: "o2", channel: "amazon", qty: 3, price: 84, discount: 0 });
    const b = calc().channelBreakdown.amazon;
    expect(b.units).toBe(5);          // not 5 + 2
    expect(b.seeded.units).toBe(2);
    expect(b.seeded.totalCogs).toBeLessThan(b.totalCogs);
  });

  it("tolerates cent-level rounding on a multi-unit line", () => {
    line({ id: "o1", channel: "amazon", qty: 3, price: 84, discount: 83.997 });
    expect(calc().channelBreakdown.amazon.seeded.units).toBe(3);
  });

  it("does not call a genuinely $0-priced line seeded", () => {
    // A $0 price with no promotion is a transfer or a data gap, not a Vine
    // giveaway — those are handled by the suspected-transfer guard instead.
    line({ id: "o1", channel: "amazon", qty: 2, price: 0, discount: 0 });
    expect(calc().channelBreakdown.amazon.seeded.units).toBe(0);
  });

  it("splits per channel, not across them", () => {
    line({ id: "o1", channel: "amazon", qty: 2, price: 56, discount: 56 });
    line({ id: "o2", channel: "shopify_dtc", qty: 4, price: 112, discount: 0 });
    const c = calc();
    expect(c.channelBreakdown.amazon.seeded.units).toBe(2);
    expect(c.channelBreakdown.shopify_dtc.seeded.units).toBe(0);
  });
});

describe("the journal", () => {
  const sum = (lines: Array<Record<string, unknown>>) =>
    Math.round(lines.reduce((t, l) => t + (l.LineAmount as number), 0) * 100) / 100;

  it("routes seeded cost to the seeding account and the rest to COGS", async () => {
    setSeedingAccount("6210");
    line({ id: "o1", channel: "amazon", qty: 2, price: 56, discount: 56 });
    line({ id: "o2", channel: "amazon", qty: 3, price: 84, discount: 0 });

    const j = await buildDailyCogsJournal(DAY, calc());
    const seedLines = j.JournalLines.filter((l) => l.AccountCode === "6210");
    expect(seedLines.length).toBeGreaterThan(0);
    // 2 units × $5 product + $1 freight + $0.50 duties = $13.00
    expect(sum(seedLines)).toBe(13);
    expect(seedLines.every((l) => String(l.Description).startsWith("Product seeding"))).toBe(true);
  });

  it("still balances to zero after the split", async () => {
    setSeedingAccount("6210");
    line({ id: "o1", channel: "amazon", qty: 2, price: 56, discount: 56 });
    line({ id: "o2", channel: "amazon", qty: 3, price: 84, discount: 0 });

    const j = await buildDailyCogsJournal(DAY, calc());
    expect(sum(j.JournalLines)).toBe(0);
  });

  it("carries the sales-channel tracking onto the seeding lines", async () => {
    // One account for every channel; which channel seeded the stock is
    // carried by tracking, which is the whole reason there is one account.
    setSeedingAccount("6210");
    sqlite.prepare(`
      INSERT INTO settings (key, value) VALUES ('xero_channel_amazon', ?)
    `).run(JSON.stringify({
      trackingCategoryId: "tc-1", trackingCategoryName: "Sales Channel", trackingOptionName: "Amazon",
    }));
    line({ id: "o1", channel: "amazon", qty: 2, price: 56, discount: 56 });

    const j = await buildDailyCogsJournal(DAY, calc());
    const seed = j.JournalLines.find((l) => l.AccountCode === "6210");
    expect(seed).toBeDefined();
  });

  it("reports sold units, not total units, on the COGS line", async () => {
    setSeedingAccount("6210");
    line({ id: "o1", channel: "amazon", qty: 2, price: 56, discount: 56 });
    line({ id: "o2", channel: "amazon", qty: 3, price: 84, discount: 0 });

    const j = await buildDailyCogsJournal(DAY, calc());
    const cogs = j.JournalLines.find((l) => String(l.Description).startsWith("COGS Product"));
    expect(String(cogs!.Description)).toContain("(3u)");
  });

  it("behaves exactly as before when no seeding account is configured", async () => {
    setSeedingAccount(null);
    line({ id: "o1", channel: "amazon", qty: 2, price: 56, discount: 56 });
    line({ id: "o2", channel: "amazon", qty: 3, price: 84, discount: 0 });

    const j = await buildDailyCogsJournal(DAY, calc());
    expect(j.JournalLines.some((l) => String(l.Description).startsWith("Product seeding"))).toBe(false);
    const cogs = j.JournalLines.find((l) => String(l.Description).startsWith("COGS Product"));
    expect(String(cogs!.Description)).toContain("(5u)");
    expect(sum(j.JournalLines)).toBe(0);
  });

  it("emits no COGS line when every unit was seeded", async () => {
    // Xero rejects zero lines, so an all-Vine day must not push an empty one.
    setSeedingAccount("6210");
    line({ id: "o1", channel: "amazon", qty: 2, price: 56, discount: 56 });

    const j = await buildDailyCogsJournal(DAY, calc());
    expect(j.JournalLines.some((l) => String(l.Description).startsWith("COGS Product"))).toBe(false);
    expect(sum(j.JournalLines)).toBe(0);
  });
});
