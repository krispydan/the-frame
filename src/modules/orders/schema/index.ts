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
  shipheroOrderId: text("shiphero_order_id"),
  shipheroOrderNumber: text("shiphero_order_number"),
  shipheroFulfillmentStatus: text("shiphero_fulfillment_status"),
  // Recipient from the order's shipping address (company || person name).
  // Captured at order-create; used directly in the fulfilled Slack alert.
  shipToName: text("ship_to_name"),
  // Shipping destination country (ISO-2, e.g. "US", "CA", "GB"). Captured
  // at order-create; drives the international-shipping-request flow.
  shipToCountry: text("ship_to_country"),
  // Shopify sales-channel attribution (order.source_name), e.g. "faire",
  // "web", "pos". Used to confirm a wholesale order originated from Faire.
  sourceName: text("source_name"),
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

// ── International Shipping Requests ──
// Non-US Faire orders require Jaxy to generate the shipping label through
// Faire (customs/duties). This tracks the back-and-forth with the 3PL:
// we email the warehouse for dims/weight, then create the label in Faire,
// upload it to ShipHero, and mark it shipped.
export const internationalShippingRequests = sqliteTable("international_shipping_requests", {
  id: id(),
  orderId: text("order_id").notNull().references(() => orders.id),
  orderNumber: text("order_number").notNull(),
  externalId: text("external_id"), // Shopify order ID
  shipheroOrderId: text("shiphero_order_id"),
  shipToCountry: text("ship_to_country"),
  sourceName: text("source_name"), // e.g. "faire"
  status: text("status", {
    enum: ["awaiting_dims", "awaiting_label", "label_uploaded", "shipped", "cancelled"],
  }).notNull().default("awaiting_dims"),
  // Email tracking
  emailSentAt: text("email_sent_at"),
  resendMessageId: text("resend_message_id"),
  // Dims/weight received from the warehouse (nullable until they reply)
  packagedLengthIn: real("packaged_length_in"),
  packagedWidthIn: real("packaged_width_in"),
  packagedHeightIn: real("packaged_height_in"),
  packagedWeightLb: real("packaged_weight_lb"),
  boxCount: integer("box_count").default(1),
  dimsReceivedAt: text("dims_received_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  index("idx_intl_ship_order_id").on(table.orderId),
  index("idx_intl_ship_status").on(table.status),
]);
