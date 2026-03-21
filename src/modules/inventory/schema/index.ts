import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// NOTE: We use plain text references to catalog_skus to avoid circular imports.
// The foreign key constraints are enforced at the SQLite level via the seed script.

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const timestamp = (name: string) => text(name).default(sql`(datetime('now'))`);

// ── Factories ──
export const factories = sqliteTable("inventory_factories", {
  id: id(),
  code: text("code").notNull().unique(), // JX1, JX2, JX3, JX4
  name: text("name").notNull(),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  productionLeadDays: integer("production_lead_days").notNull().default(30),
  transitLeadDays: integer("transit_lead_days").notNull().default(25),
  moq: integer("moq").default(300),
  notes: text("notes"),
  createdAt: timestamp("created_at"),
});

// ── Inventory ──
export const inventory = sqliteTable("inventory", {
  id: id(),
  skuId: text("sku_id").notNull(),
  location: text("location", {
    enum: ["factory", "in_transit", "warehouse", "3pl"],
  }).notNull().default("warehouse"),
  quantity: integer("quantity").notNull().default(0),
  reservedQuantity: integer("reserved_quantity").notNull().default(0),
  reorderPoint: integer("reorder_point").notNull().default(50),
  sellThroughWeekly: real("sell_through_weekly").default(0),
  daysOfStock: real("days_of_stock").default(0),
  reorderDate: text("reorder_date"),
  needsReorder: integer("needs_reorder", { mode: "boolean" }).default(false),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  index("idx_inventory_sku_id").on(table.skuId),
  index("idx_inventory_location").on(table.location),
  index("idx_inventory_needs_reorder").on(table.needsReorder),
]);

// ── Inventory Movements ──
export const inventoryMovements = sqliteTable("inventory_movements", {
  id: id(),
  skuId: text("sku_id").notNull(),
  fromLocation: text("from_location"),
  toLocation: text("to_location"),
  quantity: integer("quantity").notNull(),
  reason: text("reason", {
    enum: ["purchase", "sale", "return", "adjustment", "transfer"],
  }).notNull(),
  referenceId: text("reference_id"),
  createdAt: timestamp("created_at"),
}, (table) => [
  index("idx_movements_sku_id").on(table.skuId),
  index("idx_movements_created_at").on(table.createdAt),
]);

// ── Purchase Orders v2 ──
export const purchaseOrdersV2 = sqliteTable("inventory_purchase_orders", {
  id: id(),
  poNumber: text("po_number").notNull().unique(),
  factoryId: text("factory_id").notNull().references(() => factories.id),
  status: text("status", {
    enum: ["draft", "submitted", "confirmed", "in_production", "shipped", "in_transit", "received", "complete"],
  }).notNull().default("draft"),
  totalUnits: integer("total_units").notNull().default(0),
  totalCost: real("total_cost").notNull().default(0),
  orderDate: text("order_date"),
  expectedShipDate: text("expected_ship_date"),
  expectedArrivalDate: text("expected_arrival_date"),
  actualArrivalDate: text("actual_arrival_date"),
  trackingNumber: text("tracking_number"),
  trackingCarrier: text("tracking_carrier"),
  shippingCost: real("shipping_cost").default(0),
  dutiesCost: real("duties_cost").default(0),
  freightCost: real("freight_cost").default(0),
  notes: text("notes"),
  createdAt: timestamp("created_at"),
});

// ── PO Line Items ──
export const poLineItems = sqliteTable("inventory_po_line_items", {
  id: id(),
  poId: text("po_id").notNull().references(() => purchaseOrdersV2.id, { onDelete: "cascade" }),
  skuId: text("sku_id").notNull(),
  quantity: integer("quantity").notNull(),
  unitCost: real("unit_cost").notNull().default(0),
  totalCost: real("total_cost").notNull().default(0),
}, (table) => [
  index("idx_po_line_items_po_id").on(table.poId),
]);

// ── QC Inspections ──
export const qcInspections = sqliteTable("inventory_qc_inspections", {
  id: id(),
  poId: text("po_id").notNull().references(() => purchaseOrdersV2.id),
  inspector: text("inspector"),
  inspectionDate: text("inspection_date"),
  totalUnits: integer("total_units").notNull().default(0),
  defectCount: integer("defect_count").notNull().default(0),
  defectRate: real("defect_rate").notNull().default(0),
  status: text("status", {
    enum: ["pending", "passed", "failed", "conditional"],
  }).notNull().default("pending"),
  notes: text("notes"),
  createdAt: timestamp("created_at"),
});
