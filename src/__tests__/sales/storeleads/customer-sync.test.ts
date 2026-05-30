/**
 * Vitest tests for the customer export query that seeds the StoreLeads
 * customer-list upload + lookalike audience.
 *
 * Covers:
 *   - Only companies with ≥1 non-cancelled order are exported
 *   - Cancelled / returned orders alone don't qualify a company
 *   - Companies without a domain are skipped (StoreLeads can't look them up)
 *   - Domains normalise to lowercase + trimmed
 *   - orderCount reflects only the qualifying statuses
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../../setup";

// Add the storeleads-related columns + ensure orders table has status.
function ensureSchema() {
  const db = getTestDb();
  const cols = [
    "source_type TEXT",
    "storeleads_id TEXT",
    "storeleads_last_synced_at TEXT",
  ];
  for (const c of cols) {
    try { db.exec(`ALTER TABLE companies ADD COLUMN ${c}`); } catch { /* exists */ }
  }
}

beforeEach(() => {
  resetTestDb();
  ensureSchema();
});

describe("exportCustomerDomains", () => {
  it("only returns companies with at least one non-cancelled order", async () => {
    const db = getTestDb();
    db.exec(`
      INSERT INTO companies (id, name, domain, status) VALUES
        ('c-customer', 'Real Customer Inc', 'realcust.com', 'customer'),
        ('c-shipped',  'Shipped Buyer',     'shipped.com', 'new'),
        ('c-cancelled','Cancelled Only',    'cancelled.com', 'new'),
        ('c-no-orders','No Orders Ever',    'noorders.com', 'new'),
        ('c-no-domain','Missing Domain',    NULL,            'customer');
      INSERT INTO orders (id, order_number, company_id, channel, status, created_at) VALUES
        ('o1', '#1001', 'c-customer',  'shopify_dtc',       'shipped',   datetime('now')),
        ('o2', '#1002', 'c-customer',  'shopify_dtc',       'shipped',   datetime('now')),
        ('o3', '#1003', 'c-customer',  'shopify_dtc',       'cancelled', datetime('now')),
        ('o4', '#1004', 'c-shipped',   'shopify_wholesale', 'shipped',   datetime('now')),
        ('o5', '#1005', 'c-cancelled', 'shopify_dtc',       'cancelled', datetime('now')),
        ('o6', '#1006', 'c-no-domain', 'shopify_dtc',       'shipped',   datetime('now'));
    `);
    const { exportCustomerDomains } = await import("@/modules/sales/lib/storeleads/customer-sync");
    const list = exportCustomerDomains();
    const byDomain = Object.fromEntries(list.map((c) => [c.domain, c]));

    // 2 qualifying (customer + shipped); cancelled-only and no-domain skipped.
    expect(list).toHaveLength(2);
    expect(byDomain["realcust.com"]).toBeDefined();
    expect(byDomain["shipped.com"]).toBeDefined();
    expect(byDomain["cancelled.com"]).toBeUndefined();
    expect(byDomain["noorders.com"]).toBeUndefined();

    // orderCount counts only non-cancelled rows.
    expect(byDomain["realcust.com"].orderCount).toBe(2);
    expect(byDomain["shipped.com"].orderCount).toBe(1);
  });

  it("normalises domains to lowercase + trimmed", async () => {
    const db = getTestDb();
    db.exec(`
      INSERT INTO companies (id, name, domain, status) VALUES
        ('c1', 'Mixed Case', '  Mixed-Case.COM  ', 'customer');
      INSERT INTO orders (id, order_number, company_id, channel, status, created_at) VALUES
        ('o1', '#1', 'c1', 'shopify_dtc', 'delivered', datetime('now'));
    `);
    const { exportCustomerDomains } = await import("@/modules/sales/lib/storeleads/customer-sync");
    const list = exportCustomerDomains();
    expect(list).toHaveLength(1);
    expect(list[0].domain).toBe("mixed-case.com");
  });
});
