import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import { sqlite } from "@/lib/db";
import { createLayersForShipment, type ShipmentInput } from "@/modules/finance/lib/cogs-ingest";

function seedSku(id: string, sku: string) {
  sqlite.prepare("INSERT OR IGNORE INTO catalog_products (id, name) VALUES ('p1','Test')").run();
  sqlite.prepare("INSERT INTO catalog_skus (id, product_id, sku) VALUES (?, 'p1', ?)").run(id, sku);
}

const base: ShipmentInput = {
  factory: "HD", mode: "ocean", poNumber: "JAX200", invoiceNumber: "HYT-2",
  receivedAt: "2026-05-28", freightTotal: 100, brokerTotal: 20, dutyTotal: 60,
  lines: [
    { sku: "JX2-A", units: 100, unitCost: 2.0 },
    { sku: "JX2-B", units: 100, unitCost: 4.0 },
  ],
};

describe("cogs-ingest createLayersForShipment", () => {
  beforeEach(() => { getTestDb(); resetTestDb(); seedSku("a", "JX2-A"); seedSku("b", "JX2-B"); });

  it("dry run computes landed by value, writes nothing", () => {
    const r = createLayersForShipment(base, { apply: false });
    expect(r.created).toBe(2);
    expect(r.sumFactory).toBe(600); // 200 + 400
    // freight+broker=120, duty=60 → 180 allocated by value (1/3 to A, 2/3 to B)
    // A: 200 product + 60 alloc = 260; B: 400 + 120 = 520 → landed 780
    expect(r.landedTotal).toBeCloseTo(780, 1);
    expect((sqlite.prepare("SELECT COUNT(*) c FROM inventory_cost_layers").get() as { c: number }).c).toBe(0);
  });

  it("apply writes layers with correct per-unit landed cost", () => {
    const r = createLayersForShipment(base, { apply: true });
    expect(r.created).toBe(2);
    const a = sqlite.prepare("SELECT * FROM inventory_cost_layers WHERE sku_id='a'").get() as { quantity: number; landed_cost_per_unit: number; shipping_method: string };
    expect(a.quantity).toBe(100);
    // A value share = 200/600 = 1/3 → alloc 180/3 = 60 over 100 units = 0.60/unit
    expect(a.landed_cost_per_unit).toBeCloseTo(2.6, 2);
    expect(a.shipping_method).toBe("ocean");
  });

  it("is idempotent per (poNumber, sku)", () => {
    createLayersForShipment(base, { apply: true });
    const again = createLayersForShipment(base, { apply: true });
    expect(again.created).toBe(0);
    expect(again.skipped).toBe(2);
  });

  it("blocks writes when validation gate fails", () => {
    const bad = { ...base, expectedUnits: 999 };
    const r = createLayersForShipment(bad, { apply: true });
    expect(r.validation.unitsOk).toBe(false);
    expect((sqlite.prepare("SELECT COUNT(*) c FROM inventory_cost_layers").get() as { c: number }).c).toBe(0);
  });

  it("reports unmapped SKUs without throwing", () => {
    const r = createLayersForShipment({ ...base, lines: [{ sku: "NOPE", units: 10, unitCost: 1 }] }, { apply: true });
    expect(r.unmapped).toEqual(["NOPE"]);
    expect(r.created).toBe(0);
  });
});
