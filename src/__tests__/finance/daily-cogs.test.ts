import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import { sqlite } from "@/lib/db";

// Xero + Slack are external — stub them so the job runs offline.
vi.mock("@/modules/finance/lib/xero-client", () => ({
  postManualJournal: vi.fn(async (payload: { JournalLines: unknown[] }) => ({
    success: true, manualJournalId: "xero_mj_1", status: "POSTED", data: payload,
  })),
}));
vi.mock("@/modules/integrations/lib/slack/notifications", () => ({
  notifyCogsDailySummary: vi.fn(async () => {}),
  notifyCogsRunFailed: vi.fn(async () => {}),
  notifyCogsException: vi.fn(async () => {}),
}));
// Channel config: return a mapping so journal lines resolve account codes.
vi.mock("@/modules/finance/lib/shipment-revenue-recognition", () => ({
  loadChannelXeroConfig: vi.fn(async () => ({
    salesAccountCode: "4030", deferredRevenueAccountCode: "2050",
    cogsAccountCode: "5000", inventoryAccountCode: "1400",
    trackingCategoryId: "tc1", trackingCategoryName: "Sales Channel", trackingOptionName: "Shopify - Retail",
  })),
}));

import { runDailyCogsPosting } from "@/modules/finance/lib/daily-cogs";
import { createCostLayer } from "@/modules/finance/lib/fifo-engine";
import { postManualJournal } from "@/modules/finance/lib/xero-client";

const DAY = "2026-06-20";

function seedProductSku(skuId: string, sku: string) {
  sqlite.prepare("INSERT OR IGNORE INTO catalog_products (id, name) VALUES ('p1','Test')").run();
  sqlite.prepare("INSERT INTO catalog_skus (id, product_id, sku) VALUES (?, 'p1', ?)").run(skuId, sku);
}
function seedShippedOrder(orderId: string, num: string, items: Array<{ id: string; sku: string; skuId: string | null; qty: number }>, channel = "shopify_dtc") {
  sqlite.prepare(
    "INSERT INTO orders (id, order_number, channel, status, total, shipped_at) VALUES (?, ?, ?, 'shipped', 0, ?)",
  ).run(orderId, num, channel, `${DAY}T12:00:00`);
  for (const it of items) {
    sqlite.prepare(
      "INSERT INTO order_items (id, order_id, sku, sku_id, product_name, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, 'Test', ?, 0, 0)",
    ).run(it.id, orderId, it.sku, it.skuId, it.qty);
  }
}

describe("daily COGS job", () => {
  beforeEach(() => {
    getTestDb();
    resetTestDb();
    vi.clearAllMocks();
  });

  describe("dry run — guards classify without writing", () => {
    it("flags unmapped SKU, shortfall, and clean lines", async () => {
      seedProductSku("unit_a", "JX1001-BLK");
      createCostLayer({ skuId: "unit_a", quantity: 100, unitCost: 1.5, freightPerUnit: 0.1, dutiesPerUnit: 0.05 });
      seedShippedOrder("o1", "1001", [{ id: "oi1", sku: "JX1001-BLK", skuId: "unit_a", qty: 10 }]); // clean
      seedShippedOrder("o2", "1002", [{ id: "oi2", sku: "MYSTERY-SKU", skuId: null, qty: 3 }]);      // unmapped
      seedProductSku("unit_b", "JX9999-RED");
      seedShippedOrder("o3", "1003", [{ id: "oi3", sku: "JX9999-RED", skuId: "unit_b", qty: 5 }]);    // shortfall (no layer)

      const r = await runDailyCogsPosting({ date: DAY, dryRun: true });
      expect(r.mode).toBe("dry_run");
      expect(r.ordersProcessed).toBe(3);
      expect(r.unitsCosted).toBe(10);
      const types = r.exceptions.map((e) => e.type).sort();
      expect(types).toContain("unmapped_sku");
      expect(types).toContain("shortfall");
      // dry run writes nothing
      expect((sqlite.prepare("SELECT COUNT(*) c FROM inventory_cost_depletions").get() as { c: number }).c).toBe(0);
      expect((sqlite.prepare("SELECT COUNT(*) c FROM cogs_exceptions").get() as { c: number }).c).toBe(0);
    });

    it("flags a zero-cost layer (bad data) without consuming it", async () => {
      seedProductSku("unit_a", "JX1001-BLK");
      // Force a $0 layer directly (bypass createCostLayer's guard) to simulate bad legacy data.
      sqlite.prepare(`INSERT INTO inventory_cost_layers
        (id, sku_id, quantity, remaining_quantity, unit_cost, freight_per_unit, duties_per_unit, landed_cost_per_unit, received_at)
        VALUES ('cl0','unit_a',100,100,0,0,0,0,'2026-06-01')`).run();
      seedShippedOrder("o1", "1001", [{ id: "oi1", sku: "JX1001-BLK", skuId: "unit_a", qty: 5 }]);

      const r = await runDailyCogsPosting({ date: DAY, dryRun: true });
      expect(r.exceptions.some((e) => e.type === "zero_cost")).toBe(true);
      expect(r.unitsCosted).toBe(0);
    });
  });

  describe("live run", () => {
    it("deplete + post one journal, write run log, resolve on success", async () => {
      seedProductSku("unit_a", "JX1001-BLK");
      createCostLayer({ skuId: "unit_a", quantity: 100, unitCost: 1.5, freightPerUnit: 0.1, dutiesPerUnit: 0.05 });
      seedShippedOrder("o1", "1001", [{ id: "oi1", sku: "JX1001-BLK", skuId: "unit_a", qty: 10 }]);

      const r = await runDailyCogsPosting({ date: DAY });
      expect(r.mode).toBe("live");
      expect(r.unitsCosted).toBe(10);
      expect(r.totalCogs).toBeCloseTo(16.5, 2); // 10 × 1.65
      expect(r.xeroJournalId).toBe("xero_mj_1");
      expect(postManualJournal).toHaveBeenCalledOnce();

      // Journal balances: debits sum = -credit
      const payload = (postManualJournal as unknown as { mock: { calls: Array<[{ JournalLines: Array<{ LineAmount: number }> }]> } }).mock.calls[0][0];
      const sum = payload.JournalLines.reduce((s, l) => s + l.LineAmount, 0);
      expect(Math.abs(sum)).toBeLessThan(0.001);

      // depletion + run log written
      expect((sqlite.prepare("SELECT COUNT(*) c FROM inventory_cost_depletions").get() as { c: number }).c).toBe(1);
      expect((sqlite.prepare("SELECT COUNT(*) c FROM cogs_run_log WHERE mode='live'").get() as { c: number }).c).toBe(1);
    });

    it("tags COGS as Faire when a Faire settlement is linked (even though channel is wholesale)", async () => {
      seedProductSku("unit_a", "JX1001-BLK");
      createCostLayer({ skuId: "unit_a", quantity: 100, unitCost: 1.5 });
      // Faire order living as shopify_wholesale, with a linked Faire settlement.
      seedShippedOrder("o1", "1001", [{ id: "oi1", sku: "JX1001-BLK", skuId: "unit_a", qty: 10 }], "shopify_wholesale");
      sqlite.prepare("INSERT INTO settlements (id, channel) VALUES ('s1','faire')").run();
      sqlite.prepare("INSERT INTO settlement_line_items (id, settlement_id, order_id) VALUES ('sli1','s1','o1')").run();

      await runDailyCogsPosting({ date: DAY });
      const dep = sqlite.prepare("SELECT channel FROM inventory_cost_depletions WHERE order_id='o1'").get() as { channel: string };
      expect(dep.channel).toBe("faire");
    });

    it("is idempotent — re-run after posted is skipped", async () => {
      seedProductSku("unit_a", "JX1001-BLK");
      createCostLayer({ skuId: "unit_a", quantity: 100, unitCost: 1.5 });
      seedShippedOrder("o1", "1001", [{ id: "oi1", sku: "JX1001-BLK", skuId: "unit_a", qty: 10 }]);
      await runDailyCogsPosting({ date: DAY });
      const again = await runDailyCogsPosting({ date: DAY });
      expect(again.skipped).toMatch(/already posted/);
      expect((postManualJournal as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
    });
  });
});
