/**
 * Seed finance tables: settlements, settlement_line_items, expense_categories, expenses
 */
import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "the-frame.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ── Create Tables ──
db.exec(`
  CREATE TABLE IF NOT EXISTS settlements (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL CHECK(channel IN ('shopify_dtc', 'shopify_wholesale', 'faire', 'amazon')),
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    gross_amount REAL NOT NULL DEFAULT 0,
    fees REAL NOT NULL DEFAULT 0,
    adjustments REAL NOT NULL DEFAULT 0,
    net_amount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    external_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'received', 'reconciled', 'synced_to_xero')),
    received_at TEXT,
    xero_transaction_id TEXT,
    xero_synced_at TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_settlements_channel ON settlements(channel);
  CREATE INDEX IF NOT EXISTS idx_settlements_status ON settlements(status);
  CREATE INDEX IF NOT EXISTS idx_settlements_period ON settlements(period_start, period_end);
  CREATE INDEX IF NOT EXISTS idx_settlements_external_id ON settlements(external_id);

  CREATE TABLE IF NOT EXISTS settlement_line_items (
    id TEXT PRIMARY KEY,
    settlement_id TEXT NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
    order_id TEXT,
    type TEXT NOT NULL CHECK(type IN ('sale', 'refund', 'fee', 'adjustment')),
    description TEXT,
    amount REAL NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sli_settlement_id ON settlement_line_items(settlement_id);
  CREATE INDEX IF NOT EXISTS idx_sli_order_id ON settlement_line_items(order_id);
  CREATE INDEX IF NOT EXISTS idx_sli_type ON settlement_line_items(type);

  CREATE TABLE IF NOT EXISTS expense_categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT,
    budget_monthly REAL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    category_id TEXT REFERENCES expense_categories(id),
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    vendor TEXT,
    date TEXT NOT NULL,
    recurring INTEGER NOT NULL DEFAULT 0,
    frequency TEXT CHECK(frequency IN ('weekly', 'monthly', 'quarterly', 'annually')),
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id);
  CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
  CREATE INDEX IF NOT EXISTS idx_expenses_vendor ON expenses(vendor);
  CREATE INDEX IF NOT EXISTS idx_expenses_recurring ON expenses(recurring);
`);

console.log("✅ Finance tables created");

// ── Seed Expense Categories ──
const categories = [
  { id: "cat-cogs", name: "Cost of Goods Sold", parentId: null, budget: null },
  { id: "cat-shipping", name: "Shipping & Fulfillment", parentId: null, budget: 3000 },
  { id: "cat-marketing", name: "Marketing & Advertising", parentId: null, budget: 5000 },
  { id: "cat-software", name: "Software & Tools", parentId: null, budget: 1500 },
  { id: "cat-ops", name: "Operations", parentId: null, budget: 2000 },
  { id: "cat-payroll", name: "Payroll & Contractors", parentId: null, budget: 15000 },
  { id: "cat-rent", name: "Rent & Utilities", parentId: null, budget: 2500 },
  { id: "cat-insurance", name: "Insurance", parentId: null, budget: 500 },
  { id: "cat-legal", name: "Legal & Professional", parentId: null, budget: 1000 },
  { id: "cat-travel", name: "Trade Shows & Travel", parentId: null, budget: 2000 },
  { id: "cat-samples", name: "Samples & Photography", parentId: null, budget: 1500 },
  { id: "cat-other", name: "Other", parentId: null, budget: 1000 },
];

const catStmt = db.prepare(`INSERT OR IGNORE INTO expense_categories (id, name, parent_id, budget_monthly) VALUES (?, ?, ?, ?)`);
for (const c of categories) {
  catStmt.run(c.id, c.name, c.parentId, c.budget);
}
console.log(`✅ Seeded ${categories.length} expense categories`);

// ── Seed Sample Settlements ──
const now = new Date();
const sampleSettlements = [
  // Shopify DTC — weekly payouts
  {
    id: "stl-shopify-dtc-w1",
    channel: "shopify_dtc",
    periodStart: "2026-03-02",
    periodEnd: "2026-03-08",
    grossAmount: 12450.00,
    fees: 362.10,
    adjustments: 0,
    netAmount: 12087.90,
    externalId: "shopify_payout_sample_1",
    status: "received",
    receivedAt: "2026-03-10",
    lineItems: [
      { type: "sale", description: "36 DTC orders", amount: 12450.00 },
      { type: "fee", description: "Shopify Payments fees (2.9%)", amount: -362.10 },
    ],
  },
  {
    id: "stl-shopify-dtc-w2",
    channel: "shopify_dtc",
    periodStart: "2026-03-09",
    periodEnd: "2026-03-15",
    grossAmount: 15820.00,
    fees: 458.78,
    adjustments: -45.00,
    netAmount: 15316.22,
    externalId: "shopify_payout_sample_2",
    status: "received",
    receivedAt: "2026-03-17",
    lineItems: [
      { type: "sale", description: "42 DTC orders", amount: 15820.00 },
      { type: "refund", description: "1 refund - damaged in transit", amount: -45.00 },
      { type: "fee", description: "Shopify Payments fees (2.9%)", amount: -458.78 },
    ],
  },
  // Shopify Wholesale — weekly
  {
    id: "stl-shopify-ws-w1",
    channel: "shopify_wholesale",
    periodStart: "2026-03-02",
    periodEnd: "2026-03-08",
    grossAmount: 28500.00,
    fees: 427.50,
    adjustments: 0,
    netAmount: 28072.50,
    externalId: "shopify_payout_ws_sample_1",
    status: "reconciled",
    receivedAt: "2026-03-10",
    lineItems: [
      { type: "sale", description: "8 wholesale orders", amount: 28500.00 },
      { type: "fee", description: "Shopify Payments fees (1.5%)", amount: -427.50 },
    ],
  },
  // Faire — monthly
  {
    id: "stl-faire-feb",
    channel: "faire",
    periodStart: "2026-02-01",
    periodEnd: "2026-02-28",
    grossAmount: 45200.00,
    fees: 11300.00,
    adjustments: -680.00,
    netAmount: 33220.00,
    externalId: "faire_settlement_feb_2026",
    status: "reconciled",
    receivedAt: "2026-03-15",
    lineItems: [
      { type: "sale", description: "32 Faire orders", amount: 45200.00 },
      { type: "refund", description: "2 returns", amount: -680.00 },
      { type: "fee", description: "Faire commission (25%)", amount: -11300.00 },
    ],
  },
  // Amazon — bi-weekly
  {
    id: "stl-amazon-w1",
    channel: "amazon",
    periodStart: "2026-03-01",
    periodEnd: "2026-03-14",
    grossAmount: 8920.00,
    fees: 1338.00,
    adjustments: -89.00,
    netAmount: 7493.00,
    externalId: "amazon_settlement_mar1_2026",
    status: "received",
    receivedAt: "2026-03-18",
    lineItems: [
      { type: "sale", description: "58 Amazon orders", amount: 8920.00 },
      { type: "refund", description: "3 returns", amount: -89.00 },
      { type: "fee", description: "Amazon referral + FBA fees (15%)", amount: -1338.00 },
    ],
  },
  // Pending settlement
  {
    id: "stl-shopify-dtc-w3",
    channel: "shopify_dtc",
    periodStart: "2026-03-16",
    periodEnd: "2026-03-22",
    grossAmount: 18200.00,
    fees: 527.80,
    adjustments: 0,
    netAmount: 17672.20,
    externalId: "shopify_payout_sample_3",
    status: "pending",
    receivedAt: null,
    lineItems: [
      { type: "sale", description: "48 DTC orders (est.)", amount: 18200.00 },
      { type: "fee", description: "Shopify Payments fees (2.9%)", amount: -527.80 },
    ],
  },
];

const stlStmt = db.prepare(`
  INSERT OR IGNORE INTO settlements (id, channel, period_start, period_end, gross_amount, fees, adjustments, net_amount, currency, external_id, status, received_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?)
`);

const sliStmt = db.prepare(`
  INSERT OR IGNORE INTO settlement_line_items (id, settlement_id, type, description, amount)
  VALUES (?, ?, ?, ?, ?)
`);

for (const s of sampleSettlements) {
  stlStmt.run(s.id, s.channel, s.periodStart, s.periodEnd, s.grossAmount, s.fees, s.adjustments, s.netAmount, s.externalId, s.status, s.receivedAt);
  for (let i = 0; i < s.lineItems.length; i++) {
    const li = s.lineItems[i];
    sliStmt.run(`${s.id}-li-${i}`, s.id, li.type, li.description, li.amount);
  }
}
console.log(`✅ Seeded ${sampleSettlements.length} sample settlements`);

// ── Seed Sample Expenses ──
const sampleExpenses = [
  { id: "exp-1", categoryId: "cat-software", description: "Shopify Plus monthly", amount: 2300, vendor: "Shopify", date: "2026-03-01", recurring: 1, frequency: "monthly" },
  { id: "exp-2", categoryId: "cat-software", description: "Faire seller plan", amount: 0, vendor: "Faire", date: "2026-03-01", recurring: 1, frequency: "monthly" },
  { id: "exp-3", categoryId: "cat-marketing", description: "Google Ads - March", amount: 3200, vendor: "Google", date: "2026-03-01", recurring: 1, frequency: "monthly" },
  { id: "exp-4", categoryId: "cat-marketing", description: "Meta Ads - March", amount: 1800, vendor: "Meta", date: "2026-03-01", recurring: 1, frequency: "monthly" },
  { id: "exp-5", categoryId: "cat-shipping", description: "ShipStation monthly", amount: 159, vendor: "ShipStation", date: "2026-03-01", recurring: 1, frequency: "monthly" },
  { id: "exp-6", categoryId: "cat-payroll", description: "Christina - March", amount: 6500, vendor: "Payroll", date: "2026-03-01", recurring: 1, frequency: "monthly" },
  { id: "exp-7", categoryId: "cat-rent", description: "Warehouse rent - March", amount: 2200, vendor: "Landlord", date: "2026-03-01", recurring: 1, frequency: "monthly" },
  { id: "exp-8", categoryId: "cat-insurance", description: "Business insurance", amount: 450, vendor: "Hiscox", date: "2026-03-01", recurring: 1, frequency: "monthly" },
  { id: "exp-9", categoryId: "cat-samples", description: "Product photography shoot", amount: 1200, vendor: "Studio LA", date: "2026-03-05", recurring: 0, frequency: null },
  { id: "exp-10", categoryId: "cat-travel", description: "Vision Expo booth deposit", amount: 3500, vendor: "Vision Expo", date: "2026-03-10", recurring: 0, frequency: null },
];

const expStmt = db.prepare(`
  INSERT OR IGNORE INTO expenses (id, category_id, description, amount, vendor, date, recurring, frequency)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const e of sampleExpenses) {
  expStmt.run(e.id, e.categoryId, e.description, e.amount, e.vendor, e.date, e.recurring, e.frequency);
}
console.log(`✅ Seeded ${sampleExpenses.length} sample expenses`);

db.close();
console.log("✅ Finance seed complete");
