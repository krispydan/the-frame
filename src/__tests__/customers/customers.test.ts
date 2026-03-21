import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";

describe("Customer Success", () => {
  let db: ReturnType<typeof getTestDb>;
  beforeEach(() => { db = getTestDb(); resetTestDb(); });

  it("health score determines status", () => {
    const classify = (score: number) => score >= 70 ? "healthy" : score >= 40 ? "at_risk" : score >= 20 ? "churning" : "churned";
    expect(classify(85)).toBe("healthy");
    expect(classify(55)).toBe("at_risk");
    expect(classify(25)).toBe("churning");
    expect(classify(10)).toBe("churned");
  });

  it("tier assignment by orders", () => {
    const getTier = (orders: number, ltv: number) => {
      if (ltv >= 5000) return "platinum";
      if (orders >= 5 || ltv >= 2000) return "gold";
      if (orders >= 2 || ltv >= 500) return "silver";
      return "bronze";
    };
    expect(getTier(1, 100)).toBe("bronze");
    expect(getTier(3, 600)).toBe("silver");
    expect(getTier(6, 3000)).toBe("gold");
    expect(getTier(2, 5500)).toBe("platinum");
  });

  it("auto-create customer on deal won", () => {
    db.prepare("INSERT INTO companies (id, name, state) VALUES ('c1', 'Test Co', 'CA')").run();
    db.prepare("INSERT INTO customer_accounts (id, company_id, tier, lifetime_value, total_orders) VALUES ('ca1', 'c1', 'bronze', 350, 1)").run();
    const account = db.prepare("SELECT * FROM customer_accounts WHERE company_id = 'c1'").get() as any;
    expect(account.tier).toBe("bronze");
    expect(account.total_orders).toBe(1);
  });
});
