import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";

describe("Finance", () => {
  let db: ReturnType<typeof getTestDb>;
  beforeEach(() => { db = getTestDb(); resetTestDb(); });

  it("settlement net = gross - fees", () => {
    db.prepare("INSERT INTO settlements (id, channel, period_start, period_end, gross_amount, fees, net_amount, status) VALUES ('s1', 'shopify_dtc', '2026-03-01', '2026-03-07', 5000, 145, 4855, 'received')").run();
    const s = db.prepare("SELECT * FROM settlements WHERE id = 's1'").get() as any;
    expect(s.net_amount).toBe(s.gross_amount - s.fees);
  });

  it("expense tracking", () => {
    db.prepare("INSERT INTO expense_categories (id, name) VALUES ('cat1', 'marketing')").run();
    db.prepare("INSERT INTO expense_categories (id, name) VALUES ('cat2', 'operations')").run();
    db.prepare("INSERT INTO expenses (id, category_id, description, amount, vendor, date) VALUES ('e1', 'cat1', 'Facebook Ads', 500, 'Meta', '2026-03-01')").run();
    db.prepare("INSERT INTO expenses (id, category_id, description, amount, vendor, date) VALUES ('e2', 'cat2', 'Shipping', 200, 'UPS', '2026-03-01')").run();
    const total = db.prepare("SELECT SUM(amount) as total FROM expenses").get() as any;
    expect(total.total).toBe(700);
  });

  it("P&L by channel", () => {
    db.prepare("INSERT INTO orders (id, order_number, channel, total) VALUES ('o1', 'ORD-1', 'shopify_dtc', 500)").run();
    db.prepare("INSERT INTO orders (id, order_number, channel, total) VALUES ('o2', 'ORD-2', 'faire', 300)").run();
    db.prepare("INSERT INTO orders (id, order_number, channel, total) VALUES ('o3', 'ORD-3', 'shopify_dtc', 200)").run();
    const channels = db.prepare("SELECT channel, SUM(total) as revenue FROM orders GROUP BY channel").all() as any[];
    const dtc = channels.find((c: any) => c.channel === "shopify_dtc");
    expect(dtc.revenue).toBe(700);
  });
});
