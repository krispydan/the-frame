import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const timestamp = (name: string) => text(name).default(sql`(datetime('now'))`);

// ── Purchase Orders ──
export const purchaseOrders = sqliteTable("catalog_purchase_orders", {
  id: id(),
  poNumber: text("po_number").unique(),
  supplier: text("supplier"),
  orderDate: text("order_date"),
  notes: text("notes"),
  status: text("status", { enum: ["ordered", "received", "processing", "complete"] }).default("ordered"),
  createdAt: timestamp("created_at"),
});

// ── Products ──
export const products = sqliteTable("catalog_products", {
  id: id(),
  skuPrefix: text("sku_prefix").unique(),
  name: text("name"),
  description: text("description"),
  shortDescription: text("short_description"),
  bulletPoints: text("bullet_points"),
  category: text("category", { enum: ["sunglasses", "optical", "reading"] }),
  frameShape: text("frame_shape"),
  frameMaterial: text("frame_material"),
  gender: text("gender"),
  lensType: text("lens_type"),
  wholesalePrice: real("wholesale_price"),
  retailPrice: real("retail_price"),
  msrp: real("msrp"),
  purchaseOrderId: text("purchase_order_id").references(() => purchaseOrders.id),
  factoryName: text("factory_name"),
  factorySku: text("factory_sku"),
  seoTitle: text("seo_title"),
  metaDescription: text("meta_description"),
  status: text("status", { enum: ["intake", "processing", "review", "approved", "published"] }).default("intake"),
  // AI category + metafield categorization (JSON blob matching the sync spec)
  aiCategorization: text("ai_categorization"),
  aiCategorizedAt: text("ai_categorized_at"),
  aiCategorizationModel: text("ai_categorization_model"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

// ── SKUs ──
export const skus = sqliteTable("catalog_skus", {
  id: id(),
  productId: text("product_id").references(() => products.id).notNull(),
  sku: text("sku").unique(),
  colorName: text("color_name"),
  colorHex: text("color_hex"),
  size: text("size"),
  upc: text("upc"),
  weightOz: real("weight_oz"),
  costPrice: real("cost_price"),
  wholesalePrice: real("wholesale_price"),
  retailPrice: real("retail_price"),
  inStock: integer("in_stock", { mode: "boolean" }).default(true),
  rawImageFilename: text("raw_image_filename"),
  seoTitle: text("seo_title"),
  metaDescription: text("meta_description"),
  twelvePackSku: text("twelve_pack_sku"),
  twelvePackUpc: text("twelve_pack_upc"),
  status: text("status", { enum: ["intake", "review", "approved"] }).default("intake"),
  createdAt: timestamp("created_at"),
});

// ── Image Types ──
export const imageTypes = sqliteTable("catalog_image_types", {
  id: id(),
  slug: text("slug").unique(),
  label: text("label"),
  aspectRatio: text("aspect_ratio"),
  minWidth: integer("min_width"),
  minHeight: integer("min_height"),
  platform: text("platform").default("all"),
  description: text("description"),
  active: integer("active", { mode: "boolean" }).default(true),
  sortOrder: integer("sort_order").default(0),
});

// ── Images ──
export const images = sqliteTable("catalog_images", {
  id: id(),
  skuId: text("sku_id").references(() => skus.id).notNull(),
  filePath: text("file_path"),
  imageTypeId: text("image_type_id").references(() => imageTypes.id),
  position: integer("position").default(0),
  altText: text("alt_text"),
  width: integer("width"),
  height: integer("height"),
  aiModelUsed: text("ai_model_used"),
  aiPrompt: text("ai_prompt"),
  status: text("status", { enum: ["draft", "review", "approved", "rejected"] }).default("draft"),
  isBest: integer("is_best", { mode: "boolean" }).default(false),
  createdAt: timestamp("created_at"),
});

// ── Tags ──
export const tags = sqliteTable("catalog_tags", {
  id: id(),
  productId: text("product_id").references(() => products.id).notNull(),
  tagName: text("tag_name"),
  dimension: text("dimension"),
  source: text("source", { enum: ["ai", "manual"] }),
});

// ── Name Options ──
export const nameOptions = sqliteTable("catalog_name_options", {
  id: id(),
  productId: text("product_id").references(() => products.id).notNull(),
  name: text("name"),
  selected: integer("selected", { mode: "boolean" }).default(false),
  aiGenerated: integer("ai_generated", { mode: "boolean" }).default(false),
});

// ── Notes ──
export const notes = sqliteTable("catalog_notes", {
  id: id(),
  entityType: text("entity_type", { enum: ["product", "sku", "image"] }),
  entityId: text("entity_id"),
  author: text("author").default("admin"),
  text: text("text"),
  createdAt: timestamp("created_at"),
});

// ── Exports ──
export const exports_ = sqliteTable("catalog_exports", {
  id: id(),
  platform: text("platform", { enum: ["shopify", "faire", "amazon"] }),
  filePath: text("file_path"),
  productCount: integer("product_count"),
  createdAt: timestamp("created_at"),
  createdBy: text("created_by").default("admin"),
});

// ── Copy Versions ──
export const copyVersions = sqliteTable("catalog_copy_versions", {
  id: id(),
  productId: text("product_id").references(() => products.id).notNull(),
  fieldName: text("field_name", { enum: ["name", "description", "short_description", "bullet_points"] }),
  content: text("content"),
  aiModel: text("ai_model"),
  createdAt: timestamp("created_at"),
});

// Factory map
export const FACTORY_MAP: Record<string, string> = {
  JX1: "TAGA",
  JX2: "HUIDE",
  JX3: "GEYA",
  JX4: "BRILLIANT",
};
