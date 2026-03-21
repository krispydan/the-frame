import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";

describe("Finance", () => {
  let db: ReturnType<typeof getTestDb>;
  beforeEach(() => { db = getTestDb(); resetTestDb(); });

  it("settlement net = gross - fees", () => {
    db.prepare("INSERT INTO settlements (id, channel, gross_amount, fees, net_amount, status) VALUES ('s1', 'shopify_dtc', 5000, 145, 4855, 'received')").run();
    const s = db.prepare("SELECT * FROM settlements WHERE id = 's1'").get() as any;
    expect(s.net_amount).toBe(s.gross_amount - s.fees);
  });

  it("expense tracking", () => {
    db.prepare("INSERT INTO expenses (id, category, description, amount, vendor) VALUES ('e1', 'marketing', 'Facebook Ads', 500, 'Meta')").run();
    db.prepare("INSERT INTO expenses (id, category, description, amount, vendor) VALUES ('e2', 'operations', 'Shipping', 200, 'UPS')").run();
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
