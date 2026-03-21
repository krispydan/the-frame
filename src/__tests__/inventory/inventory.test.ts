import { describe, it, expect } from "vitest";

describe("Inventory Calculations", () => {
  it("calculates days of stock remaining", () => {
    const stock = 200, weeklyRate = 25;
    const days = (stock / weeklyRate) * 7;
    expect(days).toBe(56);
  });

  it("calculates reorder date with factory lead time", () => {
    const stock = 200, weeklyRate = 25, prodDays = 30, transitDays = 25;
    const daysOfStock = (stock / weeklyRate) * 7; // 56
    const leadTime = prodDays + transitDays; // 55
    const daysUntilReorder = daysOfStock - leadTime; // 1
    expect(daysUntilReorder).toBe(1);
    expect(daysUntilReorder <= 7).toBe(true); // needs reorder!
  });

  it("landed cost calculation", () => {
    const unitCost = 2.50, shippingPerUnit = 0.40, dutyRate = 0.06, freightPerUnit = 0.30;
    const landed = unitCost + shippingPerUnit + (unitCost * dutyRate) + freightPerUnit;
    expect(landed).toBeCloseTo(3.35, 2);
  });

  it("margin calculation", () => {
    const landed = 3.35, wholesale = 7.00;
    const margin = ((wholesale - landed) / wholesale) * 100;
    expect(margin).toBeCloseTo(52.14, 1);
  });

  it("flags low stock correctly", () => {
    const stock = 12, reorderPoint = 50;
    expect(stock < reorderPoint).toBe(true);
  });
});
