import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { companies, stores, contacts } from "@/modules/sales/schema";
import { products, skus } from "@/modules/catalog/schema";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const timestamp = (name: string) => text(name).default(sql`(datetime('now'))`);

// ── Orders ──
export const orders = sqliteTable("orders", {
  id: id(),
  orderNumber: text("order_number").notNull(),
  companyId: text("company_id").references(() => companies.id),
  storeId: text("store_id").references(() => stores.id),
  contactId: text("contact_id").references(() => contacts.id),
  channel: text("channel", {
    enum: ["shopify_dtc", "shopify_wholesale", "faire", "direct", "phone"],
  }).notNull(),
  status: text("status", {
    enum: ["pending", "confirmed", "picking", "packed", "shipped", "delivered", "returned", "cancelled"],
  }).notNull().default("pending"),
  subtotal: real("subtotal").notNull().default(0),
  discount: real("discount").notNull().default(0),
  shipping: real("shipping").notNull().default(0),
  tax: real("tax").notNull().default(0),
  total: real("total").notNull().default(0),
  currency: text("currency").notNull().default("USD"),
  notes: text("notes"),
  externalId: text("external_id"), // Shopify/Faire order ID
  trackingNumber: text("tracking_number"),
  trackingCarrier: text("tracking_carrier"),
  placedAt: text("placed_at"),
  shippedAt: text("shipped_at"),
  deliveredAt: text("delivered_at"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  index("idx_orders_channel").on(table.channel),
  index("idx_orders_status").on(table.status),
  index("idx_orders_company_id").on(table.companyId),
  index("idx_orders_external_id").on(table.externalId),
  index("idx_orders_order_number").on(table.orderNumber),
  index("idx_orders_placed_at").on(table.placedAt),
]);

// ── Order Items ──
export const orderItems = sqliteTable("order_items", {
  id: id(),
  orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  productId: text("product_id").references(() => products.id),
  skuId: text("sku_id").references(() => skus.id),
  sku: text("sku"),
  productName: text("product_name").notNull(),
  colorName: text("color_name"),
  quantity: integer("quantity").notNull().default(1),
  unitPrice: real("unit_price").notNull().default(0),
  totalPrice: real("total_price").notNull().default(0),
}, (table) => [
  index("idx_order_items_order_id").on(table.orderId),
]);

// ── Returns ──
export const returns = sqliteTable("returns", {
  id: id(),
  orderId: text("order_id").notNull().references(() => orders.id),
  reason: text("reason"),
  status: text("status", {
    enum: ["requested", "approved", "received", "refunded"],
  }).notNull().default("requested"),
  items: text("items", { mode: "json" }).$type<Array<{ orderItemId: string; quantity: number; reason?: string }>>(),
  refundAmount: real("refund_amount"),
  notes: text("notes"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  index("idx_returns_order_id").on(table.orderId),
  index("idx_returns_status").on(table.status),
]);
