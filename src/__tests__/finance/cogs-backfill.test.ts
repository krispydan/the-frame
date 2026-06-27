import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import { sqlite } from "@/lib/db";

const { postManualJournal } = vi.hoisted(() => ({
  postManualJournal: vi.fn(async (payload: { JournalLines: Array<{ LineAmount: number }> }) => ({
    success: true as const,
    manualJournalId: `mj_${Math.round(payload.JournalLines.reduce((s, l) => s + Math.abs(l.LineAmount), 0) * 100)}`,
    status: "POSTED", data: payload,
  })),
}));
vi.mock("@/modules/finance/lib/xero-client", () => ({ postManualJournal }));
vi.mock("@/modules/integrations/lib/slack/notifications", () => ({
  notifyCogsDailySummary: vi.fn(async () => {}),
  notifyCogsRunFailed: vi.fn(async () => {}),
  notifyCogsException: vi.fn(async () => {}),
  notifyCogsCorrected: vi.fn(async () => {}),
}));
vi.mock("@/modules/finance/lib/shipment-revenue-recognition", () => ({
  loadChannelXeroConfig: vi.fn(async () => ({
    salesAccountCode: "4030", deferredRevenueAccountCode: "2050",
    cogsAccountCode: "5000", inventoryAccountCode: "1400",
    trackingCategoryId: null, trackingCategoryName: null, trackingOptionName: null,
  })),
}));

import { runCogsBackfill, correctCogsForDate } from "@/modules/finance/lib/cogs-backfill";
import { createCostLayer } from "@/modules/finance/lib/fifo-engine";

function seed(skuId: string, sku: string) {
  sqlite.prepare("INSERT OR IGNORE INTO catalog_products (id, name) VALUES ('p1','Test')").run();
  sqlite.prepare("INSERT INTO catalog_skus (id, product_id, sku) VALUES (?, 'p1', ?)").run(skuId, sku);
}
function order(id: string, num: string, day: string, sku: string, skuId: string, qty: number) {
  sqlite.prepare("INSERT INTO orders (id, order_number, channel, status, total, shipped_at) VALUES (?, ?, 'shopify_dtc', 'shipped', 0, ?)").run(id, num, `${day}T12:00:00`);
  sqlite.prepare("INSERT INTO order_items (id, order_id, sku, sku_id, product_name, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, 'Test', ?, 0, 0)").run(`oi_${id}`, id, sku, skuId, qty);
}

describe("COGS backfill + correction", () => {
  beforeEach(() => { getTestDb(); resetTestDb(); vi.clearAllMocks(); });

  it("backfill replays each day in the range", async () => {
    seed("a", "JX1-BLK");
    createCostLayer({ skuId: "a", quantity: 1000, unitCost: 2, freightPerUnit: 0.2, dutiesPerUnit: 0.1 });
    order("o1", "1", "2026-06-10", "JX1-BLK", "a", 10);
    order("o2", "2", "2026-06-12", "JX1-BLK", "a", 20);

    const dry = await runCogsBackfill({ from: "2026-06-10", to: "2026-06-12", dryRun: true });
    expect(dry.days).toHaveLength(3);          // 10, 11, 12 inclusive
    expect(dry.totalUnits).toBe(30);
    expect(postManualJournal).not.toHaveBeenCalled();

    const live = await runCogsBackfill({ from: "2026-06-10", to: "2026-06-12" });
    expect(live.totalUnits).toBe(30);
    expect(live.totalCogs).toBeCloseTo(10 * 2.3 + 20 * 2.3, 2);
    // two days had shipments → two journals
    expect(postManualJournal).toHaveBeenCalledTimes(2);
  });

  it("correctCogsForDate reverses then re-posts, restoring + re-consuming layers", async () => {
    seed("a", "JX1-BLK");
    const layer = createCostLayer({ skuId: "a", quantity: 100, unitCost: 2, freightPerUnit: 0, dutiesPerUnit: 0 });
    order("o1", "1", "2026-06-10", "JX1-BLK", "a", 10);

    await runCogsBackfill({ from: "2026-06-10", to: "2026-06-10" });
    let remaining = (sqlite.prepare("SELECT remaining_quantity r FROM inventory_cost_layers WHERE id=?").get(layer.id) as { r: number }).r;
    expect(remaining).toBe(90);

    postManualJournal.mockClear();
    const res = await correctCogsForDate("2026-06-10", { reason: "test true-up" });
    // a reversal + a fresh post
    expect(postManualJournal).toHaveBeenCalledTimes(2);
    expect(res.reversedJournalId).toBeTruthy();
    // layer remaining is unwound then re-consumed → back to 90, not 80
    remaining = (sqlite.prepare("SELECT remaining_quantity r FROM inventory_cost_layers WHERE id=?").get(layer.id) as { r: number }).r;
    expect(remaining).toBe(90);
    // exactly one live depletion set for the day
    const depCount = (sqlite.prepare("SELECT COUNT(*) c FROM inventory_cost_depletions").get() as { c: number }).c;
    expect(depCount).toBe(1);
  });
});
