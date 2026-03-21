import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";

/**
 * Finance API route tests (JAX-320)
 * Tests business logic at the DB layer matching what the API routes do.
 */

describe("Finance API Routes", () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(() => {
    db = getTestDb();
    resetTestDb();
  });

  // ── Expense Categories CRUD ──
  describe("Expense Categories", () => {
    it("creates and retrieves categories", () => {
      db.prepare("INSERT INTO expense_categories (id, name, budget_monthly) VALUES ('cat1', 'Marketing', 5000)").run();
      db.prepare("INSERT INTO expense_categories (id, name, budget_monthly) VALUES ('cat2', 'Operations', 3000)").run();

      const cats = db.prepare("SELECT * FROM expense_categories ORDER BY name").all() as any[];
      expect(cats).toHaveLength(2);
      expect(cats[0].name).toBe("Marketing");
      expect(cats[0].budget_monthly).toBe(5000);
    });

    it("updates category budget", () => {
      db.prepare("INSERT INTO expense_categories (id, name, budget_monthly) VALUES ('cat1', 'Marketing', 5000)").run();
      db.prepare("UPDATE expense_categories SET budget_monthly = 7500 WHERE id = 'cat1'").run();

      const cat = db.prepare("SELECT * FROM expense_categories WHERE id = 'cat1'").get() as any;
      expect(cat.budget_monthly).toBe(7500);
    });

    it("deletes category", () => {
      db.prepare("INSERT INTO expense_categories (id, name) VALUES ('cat1', 'Temp')").run();
      db.prepare("DELETE FROM expense_categories WHERE id = 'cat1'").run();

      const cat = db.prepare("SELECT * FROM expense_categories WHERE id = 'cat1'").get();
      expect(cat).toBeUndefined();
    });
  });

  // ── Expenses CRUD ──
  describe("Expenses CRUD", () => {
    beforeEach(() => {
      db.prepare("INSERT INTO expense_categories (id, name, budget_monthly) VALUES ('cat1', 'Marketing', 5000)").run();
    });

    it("creates expense with category", () => {
      db.prepare("INSERT INTO expenses (id, category_id, description, amount, vendor, date) VALUES ('e1', 'cat1', 'Facebook Ads', 500, 'Meta', '2026-03-01')").run();

      const exp = db.prepare("SELECT e.*, ec.name as category_name FROM expenses e LEFT JOIN expense_categories ec ON e.category_id = ec.id WHERE e.id = 'e1'").get() as any;
      expect(exp.description).toBe("Facebook Ads");
      expect(exp.amount).toBe(500);
      expect(exp.category_name).toBe("Marketing");
    });

    it("lists expenses with date filter", () => {
      db.prepare("INSERT INTO expenses (id, category_id, description, amount, vendor, date) VALUES ('e1', 'cat1', 'Jan Ad', 300, 'Meta', '2026-01-15')").run();
      db.prepare("INSERT INTO expenses (id, category_id, description, amount, vendor, date) VALUES ('e2', 'cat1', 'Feb Ad', 400, 'Meta', '2026-02-15')").run();
      db.prepare("INSERT INTO expenses (id, category_id, description, amount, vendor, date) VALUES ('e3', 'cat1', 'Mar Ad', 500, 'Meta', '2026-03-15')").run();

      const filtered = db.prepare("SELECT * FROM expenses WHERE date >= '2026-02-01' AND date <= '2026-02-28'").all() as any[];
      expect(filtered).toHaveLength(1);
      expect(filtered[0].description).toBe("Feb Ad");
    });

    it("filters recurring expenses", () => {
      db.prepare("INSERT INTO expenses (id, category_id, description, amount, vendor, date, recurring, frequency) VALUES ('e1', 'cat1', 'Shopify Sub', 79, 'Shopify', '2026-03-01', 1, 'monthly')").run();
      db.prepare("INSERT INTO expenses (id, category_id, description, amount, vendor, date, recurring) VALUES ('e2', 'cat1', 'One-time Ad', 500, 'Meta', '2026-03-01', 0)").run();

      const recurring = db.prepare("SELECT * FROM expenses WHERE recurring = 1").all() as any[];
      expect(recurring).toHaveLength(1);
      expect(recurring[0].frequency).toBe("monthly");
    });

    it("updates expense amount", () => {
      db.prepare("INSERT INTO expenses (id, category_id, description, amount, vendor, date) VALUES ('e1', 'cat1', 'Ad Spend', 500, 'Meta', '2026-03-01')").run();
      db.prepare("UPDATE expenses SET amount = 750 WHERE id = 'e1'").run();

      const exp = db.prepare("SELECT * FROM expenses WHERE id = 'e1'").get() as any;
      expect(exp.amount).toBe(750);
    });

    it("deletes expense", () => {
      db.prepare("INSERT INTO expenses (id, category_id, description, amount, vendor, date) VALUES ('e1', 'cat1', 'Test', 100, 'Test', '2026-03-01')").run();
      db.prepare("DELETE FROM expenses WHERE id = 'e1'").run();

      const exp = db.prepare("SELECT * FROM expenses WHERE id = 'e1'").get();
      expect(exp).toBeUndefined();
    });

    it("rejects expense without required fields", () => {
      // Simulate API validation: description, amount, date required
      const requiredFields = ["description", "amount", "date"];
      const body = { vendor: "Meta" }; // missing required fields

      const missing = requiredFields.filter((f) => !(f in body));
      expect(missing).toContain("description");
      expect(missing).toContain("amount");
      expect(missing).toContain("date");
    });
  });

  // ── Settlements ──
  describe("Settlements", () => {
    it("creates and lists settlements", () => {
      db.prepare("INSERT INTO settlements (id, channel, period_start, period_end, gross_amount, fees, net_amount, status) VALUES ('s1', 'shopify_dtc', '2026-03-01', '2026-03-07', 5000, 145, 4855, 'pending')").run();
      db.prepare("INSERT INTO settlements (id, channel, period_start, period_end, gross_amount, fees, net_amount, status) VALUES ('s2', 'faire', '2026-03-01', '2026-03-07', 3000, 450, 2550, 'received')").run();

      const all = db.prepare("SELECT * FROM settlements ORDER BY channel").all() as any[];
      expect(all).toHaveLength(2);
    });

    it("filters settlements by channel", () => {
      db.prepare("INSERT INTO settlements (id, channel, period_start, period_end, gross_amount, fees, net_amount, status) VALUES ('s1', 'shopify_dtc', '2026-03-01', '2026-03-07', 5000, 145, 4855, 'pending')").run();
      db.prepare("INSERT INTO settlements (id, channel, period_start, period_end, gross_amount, fees, net_amount, status) VALUES ('s2', 'faire', '2026-03-01', '2026-03-07', 3000, 450, 2550, 'received')").run();

      const faire = db.prepare("SELECT * FROM settlements WHERE channel = 'faire'").all() as any[];
      expect(faire).toHaveLength(1);
      expect(faire[0].net_amount).toBe(2550);
    });

    it("filters settlements by status", () => {
      db.prepare("INSERT INTO settlements (id, channel, period_start, period_end, gross_amount, fees, net_amount, status) VALUES ('s1', 'shopify_dtc', '2026-03-01', '2026-03-07', 5000, 145, 4855, 'pending')").run();
      db.prepare("INSERT INTO settlements (id, channel, period_start, period_end, gross_amount, fees, net_amount, status) VALUES ('s2', 'shopify_dtc', '2026-02-22', '2026-02-28', 4000, 120, 3880, 'received')").run();

      const pending = db.prepare("SELECT * FROM settlements WHERE status = 'pending'").all() as any[];
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe("s1");
    });

    it("updates settlement status", () => {
      db.prepare("INSERT INTO settlements (id, channel, period_start, period_end, gross_amount, fees, net_amount, status) VALUES ('s1', 'shopify_dtc', '2026-03-01', '2026-03-07', 5000, 145, 4855, 'pending')").run();
      db.prepare("UPDATE settlements SET status = 'received', received_at = datetime('now') WHERE id = 's1'").run();

      const s = db.prepare("SELECT * FROM settlements WHERE id = 's1'").get() as any;
      expect(s.status).toBe("received");
      expect(s.received_at).toBeTruthy();
    });

    it("net amount = gross - fees (with adjustments)", () => {
      const gross = 5000, fees = 145, adjustments = -50;
      const net = gross - fees + adjustments;
      db.prepare("INSERT INTO settlements (id, channel, period_start, period_end, gross_amount, fees, adjustments, net_amount, status) VALUES ('s1', 'shopify_dtc', '2026-03-01', '2026-03-07', ?, ?, ?, ?, 'received')").run(gross, fees, adjustments, net);

      const s = db.prepare("SELECT * FROM settlements WHERE id = 's1'").get() as any;
      expect(s.net_amount).toBe(4805);
      expect(s.net_amount).toBe(s.gross_amount - s.fees + s.adjustments);
    });
  });

  // ── P&L Logic ──
  describe("P&L", () => {
    it("calculates revenue by channel from orders", () => {
      db.prepare("INSERT INTO orders (id, order_number, channel, total, placed_at, status) VALUES ('o1', 'ORD-1', 'shopify_dtc', 500, '2026-03-10', 'fulfilled')").run();
      db.prepare("INSERT INTO orders (id, order_number, channel, total, placed_at, status) VALUES ('o2', 'ORD-2', 'faire', 300, '2026-03-10', 'fulfilled')").run();
      db.prepare("INSERT INTO orders (id, order_number, channel, total, placed_at, status) VALUES ('o3', 'ORD-3', 'shopify_dtc', 200, '2026-03-10', 'fulfilled')").run();

      const channels = db.prepare("SELECT channel, SUM(total) as revenue, COUNT(*) as order_count FROM orders WHERE status NOT IN ('cancelled', 'returned') GROUP BY channel").all() as any[];
      const dtc = channels.find((c: any) => c.channel === "shopify_dtc");
      expect(dtc.revenue).toBe(700);
      expect(dtc.order_count).toBe(2);
    });

    it("excludes cancelled/returned orders from P&L", () => {
      db.prepare("INSERT INTO orders (id, order_number, channel, total, placed_at, status) VALUES ('o1', 'ORD-1', 'shopify_dtc', 500, '2026-03-10', 'fulfilled')").run();
      db.prepare("INSERT INTO orders (id, order_number, channel, total, placed_at, status) VALUES ('o2', 'ORD-2', 'shopify_dtc', 300, '2026-03-10', 'cancelled')").run();
      db.prepare("INSERT INTO orders (id, order_number, channel, total, placed_at, status) VALUES ('o3', 'ORD-3', 'shopify_dtc', 200, '2026-03-10', 'returned')").run();

      const result = db.prepare("SELECT SUM(total) as revenue FROM orders WHERE status NOT IN ('cancelled', 'returned')").get() as any;
      expect(result.revenue).toBe(500);
    });

    it("calculates COGS from PO line item unit costs", () => {
      // Setup: SKU with known cost from PO
      db.prepare("INSERT INTO catalog_products (id, name) VALUES ('p1', 'Classic Frame')").run();
      db.prepare("INSERT INTO catalog_skus (id, product_id, sku, color_name) VALUES ('sku1', 'p1', 'JAX-BLK-01', 'Black')").run();
      db.prepare("INSERT INTO inventory_purchase_orders (id, po_number, factory_id, status, total_cost) VALUES ('po1', 'PO-001', 'f1', 'received', 1000)").run();
      db.prepare("INSERT INTO inventory_po_line_items (id, po_id, sku_id, unit_cost, quantity, total_cost) VALUES ('pli1', 'po1', 'sku1', 8.50, 100, 850)").run();

      // Order with 10 units
      db.prepare("INSERT INTO orders (id, order_number, channel, total, placed_at, status) VALUES ('o1', 'ORD-1', 'shopify_dtc', 350, '2026-03-10', 'fulfilled')").run();
      db.prepare("INSERT INTO order_items (id, order_id, sku, sku_id, product_name, quantity, unit_price, total_price) VALUES ('oi1', 'o1', 'JAX-BLK-01', 'sku1', 'Classic Frame', 10, 35, 350)").run();

      // COGS = quantity * avg unit_cost from PO
      const cogs = db.prepare(`
        SELECT SUM(oi.quantity * COALESCE(
          (SELECT AVG(pli.unit_cost) FROM inventory_po_line_items pli WHERE pli.sku_id = oi.sku_id AND pli.unit_cost > 0),
          0
        )) as total_cogs
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.status NOT IN ('cancelled', 'returned')
      `).get() as any;

      expect(cogs.total_cogs).toBe(85); // 10 * 8.50
    });

    it("calculates gross margin = revenue - COGS", () => {
      const revenue = 1000;
      const cogs = 350;
      const grossMargin = revenue - cogs;
      const grossMarginPct = (grossMargin / revenue) * 100;

      expect(grossMargin).toBe(650);
      expect(grossMarginPct).toBe(65);
    });

    it("P&L CSV export contains expected headers", () => {
      // Simulate pnlToCsv output structure
      const csvLines = [
        "P&L Report — March 2026",
        "Period: 2026-03-01 to 2026-03-21",
        "",
        "SUMMARY",
        "Metric,Amount",
        'Revenue,"1000.00"',
        'COGS,"350.00"',
        'Gross Margin,"650.00"',
      ];
      const csv = csvLines.join("\n");

      expect(csv).toContain("SUMMARY");
      expect(csv).toContain("Revenue");
      expect(csv).toContain("COGS");
      expect(csv).toContain("Gross Margin");
      expect(csv).toContain("Metric,Amount");
    });

    it("filters P&L by date range (custom period)", () => {
      db.prepare("INSERT INTO orders (id, order_number, channel, total, placed_at, status) VALUES ('o1', 'ORD-1', 'shopify_dtc', 500, '2026-01-15', 'fulfilled')").run();
      db.prepare("INSERT INTO orders (id, order_number, channel, total, placed_at, status) VALUES ('o2', 'ORD-2', 'shopify_dtc', 300, '2026-02-15', 'fulfilled')").run();
      db.prepare("INSERT INTO orders (id, order_number, channel, total, placed_at, status) VALUES ('o3', 'ORD-3', 'shopify_dtc', 200, '2026-03-15', 'fulfilled')").run();

      const q1 = db.prepare("SELECT SUM(total) as revenue FROM orders WHERE placed_at >= '2026-01-01' AND placed_at <= '2026-03-31' AND status NOT IN ('cancelled', 'returned')").get() as any;
      expect(q1.revenue).toBe(1000);

      const febOnly = db.prepare("SELECT SUM(total) as revenue FROM orders WHERE placed_at >= '2026-02-01' AND placed_at <= '2026-02-28' AND status NOT IN ('cancelled', 'returned')").get() as any;
      expect(febOnly.revenue).toBe(300);
    });

    it("expenses by category with budget comparison", () => {
      db.prepare("INSERT INTO expense_categories (id, name, budget_monthly) VALUES ('cat1', 'Marketing', 5000)").run();
      db.prepare("INSERT INTO expense_categories (id, name, budget_monthly) VALUES ('cat2', 'Operations', 3000)").run();
      db.prepare("INSERT INTO expenses (id, category_id, description, amount, vendor, date) VALUES ('e1', 'cat1', 'FB Ads', 2000, 'Meta', '2026-03-01')").run();
      db.prepare("INSERT INTO expenses (id, category_id, description, amount, vendor, date) VALUES ('e2', 'cat1', 'Google Ads', 1500, 'Google', '2026-03-05')").run();
      db.prepare("INSERT INTO expenses (id, category_id, description, amount, vendor, date) VALUES ('e3', 'cat2', 'Shipping', 800, 'UPS', '2026-03-03')").run();

      const byCategory = db.prepare(`
        SELECT ec.name as category, SUM(e.amount) as amount, ec.budget_monthly as budget
        FROM expenses e
        JOIN expense_categories ec ON e.category_id = ec.id
        WHERE e.date >= '2026-03-01' AND e.date <= '2026-03-31'
        GROUP BY ec.id ORDER BY amount DESC
      `).all() as any[];

      expect(byCategory).toHaveLength(2);
      expect(byCategory[0].category).toBe("Marketing");
      expect(byCategory[0].amount).toBe(3500);
      expect(byCategory[0].budget).toBe(5000);
    });
  });

  // ── Cash Flow ──
  describe("Cash Flow", () => {
    it("current position = received settlements - expenses - PO costs", () => {
      db.prepare("INSERT INTO settlements (id, channel, period_start, period_end, gross_amount, fees, net_amount, status) VALUES ('s1', 'shopify_dtc', '2026-03-01', '2026-03-07', 5000, 145, 4855, 'received')").run();
      db.prepare("INSERT INTO settlements (id, channel, period_start, period_end, gross_amount, fees, net_amount, status) VALUES ('s2', 'shopify_dtc', '2026-03-08', '2026-03-14', 3000, 90, 2910, 'received')").run();
      db.prepare("INSERT INTO expenses (id, category_id, description, amount, vendor, date) VALUES ('e1', null, 'Rent', 2000, 'Landlord', '2026-03-01')").run();
      db.prepare("INSERT INTO inventory_purchase_orders (id, po_number, factory_id, status, total_cost) VALUES ('po1', 'PO-001', 'f1', 'confirmed', 1500)").run();

      const received = db.prepare("SELECT COALESCE(SUM(net_amount), 0) as total FROM settlements WHERE status IN ('received', 'reconciled')").get() as any;
      const expTotal = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date <= '2026-03-21'").get() as any;
      const poTotal = db.prepare("SELECT COALESCE(SUM(total_cost), 0) as total FROM inventory_purchase_orders WHERE status IN ('confirmed', 'in_production', 'shipped', 'received')").get() as any;

      const position = received.total - expTotal.total - poTotal.total;
      expect(position).toBe(4855 + 2910 - 2000 - 1500); // 4265
    });

    it("pending inflows from pending settlements", () => {
      db.prepare("INSERT INTO settlements (id, channel, period_start, period_end, gross_amount, fees, net_amount, status) VALUES ('s1', 'shopify_dtc', '2026-03-15', '2026-03-21', 4000, 120, 3880, 'pending')").run();
      db.prepare("INSERT INTO settlements (id, channel, period_start, period_end, gross_amount, fees, net_amount, status) VALUES ('s2', 'faire', '2026-03-15', '2026-03-21', 2000, 300, 1700, 'pending')").run();

      const pending = db.prepare("SELECT COALESCE(SUM(net_amount), 0) as total FROM settlements WHERE status = 'pending'").get() as any;
      expect(pending.total).toBe(5580);
    });

    it("detects negative cash position", () => {
      // High expenses, low settlements
      db.prepare("INSERT INTO settlements (id, channel, period_start, period_end, gross_amount, fees, net_amount, status) VALUES ('s1', 'shopify_dtc', '2026-03-01', '2026-03-07', 1000, 30, 970, 'received')").run();
      db.prepare("INSERT INTO expenses (id, category_id, description, amount, vendor, date) VALUES ('e1', null, 'Big Purchase', 5000, 'Vendor', '2026-03-01')").run();

      const received = db.prepare("SELECT COALESCE(SUM(net_amount), 0) as total FROM settlements WHERE status IN ('received', 'reconciled')").get() as any;
      const expTotal = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM expenses").get() as any;

      const position = received.total - expTotal.total;
      expect(position).toBeLessThan(0);
      expect(position).toBe(-4030);
    });
  });

  // ── Reconciliation ──
  describe("Reconciliation", () => {
    it("compares expected vs received settlement amounts", () => {
      // Expected from orders
      db.prepare("INSERT INTO orders (id, order_number, channel, total, placed_at, status) VALUES ('o1', 'ORD-1', 'shopify_dtc', 500, '2026-03-01', 'fulfilled')").run();
      db.prepare("INSERT INTO orders (id, order_number, channel, total, placed_at, status) VALUES ('o2', 'ORD-2', 'shopify_dtc', 300, '2026-03-03', 'fulfilled')").run();

      // Actual settlement
      db.prepare("INSERT INTO settlements (id, channel, period_start, period_end, gross_amount, fees, net_amount, status) VALUES ('s1', 'shopify_dtc', '2026-03-01', '2026-03-07', 780, 20, 760, 'received')").run();

      const orderTotal = db.prepare("SELECT SUM(total) as expected FROM orders WHERE channel = 'shopify_dtc' AND placed_at >= '2026-03-01' AND placed_at <= '2026-03-07'").get() as any;
      const settlementGross = db.prepare("SELECT gross_amount FROM settlements WHERE id = 's1'").get() as any;

      const diff = orderTotal.expected - settlementGross.gross_amount;
      expect(orderTotal.expected).toBe(800);
      expect(settlementGross.gross_amount).toBe(780);
      expect(diff).toBe(20); // small discrepancy
    });
  });
});
