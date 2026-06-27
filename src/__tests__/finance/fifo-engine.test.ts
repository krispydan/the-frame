import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import {
  createCostLayer,
  createCostLayersFromPO,
  resolveDepletionTarget,
  depleteInventoryFifo,
  ZeroCostError,
  MIN_PLAUSIBLE_UNIT_COST,
} from "@/modules/finance/lib/fifo-engine";
import { sqlite } from "@/lib/db";

describe("FIFO engine — Phase 3", () => {
  beforeEach(() => {
    getTestDb();
    resetTestDb();
  });

  describe("zero-cost guard", () => {
    it("rejects a $0 product cost layer", () => {
      expect(() => createCostLayer({ skuId: "sku_a", quantity: 10, unitCost: 0 })).toThrow(ZeroCostError);
    });
    it("rejects a sub-floor product cost", () => {
      expect(() => createCostLayer({ skuId: "sku_a", quantity: 10, unitCost: MIN_PLAUSIBLE_UNIT_COST - 0.01 })).toThrow(ZeroCostError);
    });
    it("allows a plausible cost", () => {
      const layer = createCostLayer({ skuId: "sku_a", quantity: 10, unitCost: 1.55 });
      expect(layer.landedCostPerUnit).toBeCloseTo(1.55, 2);
    });
    it("allows freight/duty = 0 at receipt (provisional layer)", () => {
      const layer = createCostLayer({ skuId: "sku_a", quantity: 10, unitCost: 1.55, freightPerUnit: 0, dutiesPerUnit: 0 });
      expect(layer.freightPerUnit).toBe(0);
    });
  });

  describe("resolveDepletionTarget — pack normalization", () => {
    beforeEach(() => {
      sqlite.prepare("INSERT INTO catalog_products (id, name) VALUES ('p1', 'Test')").run();
      sqlite.prepare("INSERT INTO catalog_skus (id, product_id, sku) VALUES ('unit_a', 'p1', 'JX1001-BLK')").run();
    });
    it("multiplies a 12-pack order line into units and resolves the bare SKU id", () => {
      const r = resolveDepletionTarget({ sku: "JX1001-BLK-12PK", skuId: null, quantity: 5 });
      expect(r.units).toBe(60);
      expect(r.packSize).toBe(12);
      expect(r.unitSkuId).toBe("unit_a");
    });
    it("passes unit order lines through unchanged", () => {
      const r = resolveDepletionTarget({ sku: "JX1001-BLK", skuId: "unit_a", quantity: 3 });
      expect(r.units).toBe(3);
      expect(r.unitSkuId).toBe("unit_a");
    });
  });

  describe("createCostLayersFromPO — pack + allocation + freight fix", () => {
    beforeEach(() => {
      sqlite.prepare("INSERT INTO catalog_products (id, name) VALUES ('p1', 'Test')").run();
      sqlite.prepare("INSERT INTO catalog_skus (id, product_id, sku) VALUES ('unit_a', 'p1', 'JX1001-BLK')").run();
      sqlite.prepare("INSERT INTO catalog_skus (id, product_id, sku) VALUES ('unit_b', 'p1', 'JX1001-TOR')").run();
      // PO: freight 120 + duty 60 over 1,200 total units (1000 unit line + 200 from pack line)
      sqlite.prepare(`INSERT INTO inventory_purchase_orders
        (id, po_number, factory_id, status, total_units, total_cost, shipping_method, freight_cost, duties_cost, shipping_cost)
        VALUES ('po1','PO-T-1','f1','received',1200,0,'ocean',120,60,0)`).run();
      sqlite.prepare(`INSERT INTO inventory_po_line_items (id, po_id, sku_id, quantity, pack_size, unit_cost, total_cost)
        VALUES ('li1','po1','unit_a',1000,1,1.50,1500)`).run();
      // pack line: 50 packs × 4 = 200 units
      sqlite.prepare(`INSERT INTO inventory_po_line_items (id, po_id, sku_id, quantity, pack_size, unit_cost, total_cost)
        VALUES ('li2','po1','unit_b',50,4,2.00,400)`).run();
    });

    it("stores layers in units and allocates freight/duty per unit", () => {
      const res = createCostLayersFromPO("po1");
      expect(res.created).toHaveLength(2);
      expect(res.rejected).toHaveLength(0);

      const a = res.created.find((l) => l.skuId === "unit_a")!;
      const b = res.created.find((l) => l.skuId === "unit_b")!;
      expect(a.quantity).toBe(1000);
      expect(b.quantity).toBe(200); // 50 × 4 — the pack normalization

      // freight 120 + 0 shipping over 1200 units = $0.10/unit; duty 60/1200 = $0.05/unit
      expect(a.freightPerUnit).toBeCloseTo(0.10, 4);
      expect(a.dutiesPerUnit).toBeCloseTo(0.05, 4);
      expect(a.landedCostPerUnit).toBeCloseTo(1.65, 4); // 1.50 + .10 + .05
      expect(b.landedCostPerUnit).toBeCloseTo(2.15, 4); // 2.00 + .10 + .05
    });

    it("is idempotent — second run creates nothing", () => {
      createCostLayersFromPO("po1");
      const again = createCostLayersFromPO("po1");
      expect(again.created).toHaveLength(0);
      expect(again.skipped).toBe(2);
    });

    it("FIFO depletion of a pack order draws from the unit layer", () => {
      createCostLayersFromPO("po1");
      const { unitSkuId, units } = resolveDepletionTarget({ sku: "JX1001-TOR-4PK", skuId: null, quantity: 10 });
      const dep = depleteInventoryFifo(unitSkuId!, units, { orderItemId: "oi1", orderId: "o1" });
      expect(dep.totalDepleted).toBe(40); // 10 packs × 4
      expect(dep.shortfall).toBe(0);
    });
  });
});
