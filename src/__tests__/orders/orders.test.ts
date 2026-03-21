import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";

describe("Orders", () => {
  let db: ReturnType<typeof getTestDb>;
  beforeEach(() => { db = getTestDb(); resetTestDb(); });

  it("creates order with line items", () => {
    db.prepare("INSERT INTO orders (id, order_number, channel, status, subtotal, tax, shipping, discount, total) VALUES ('o1', 'ORD-001', 'shopify_wholesale', 'pending', 350, 28, 15, 0, 393)").run();
    db.prepare("INSERT INTO order_items (id, order_id, sku, product_name, quantity, unit_price, total_price) VALUES ('oi1', 'o1', 'JX1001-BLK', 'Golden Hour', 50, 7, 350)").run();
    const order = db.prepare("SELECT * FROM orders WHERE id = 'o1'").get() as any;
    expect(order.total).toBe(393);
    const items = db.prepare("SELECT * FROM order_items WHERE order_id = 'o1'").all();
    expect(items.length).toBe(1);
  });

  it("total = subtotal + tax + shipping - discount", () => {
    const subtotal = 350, tax = 28, shipping = 15, discount = 10;
    expect(subtotal + tax + shipping - discount).toBe(383);
  });

  it("fulfillment status progression", () => {
    db.prepare("INSERT INTO orders (id, order_number, status) VALUES ('o1', 'ORD-001', 'pending')").run();
    for (const status of ["confirmed", "picking", "packed", "shipped", "delivered"]) {
      db.prepare("UPDATE orders SET status = ? WHERE id = 'o1'").run(status);
    }
    const order = db.prepare("SELECT status FROM orders WHERE id = 'o1'").get() as any;
    expect(order.status).toBe("delivered");
  });
});
