import { sqliteTable, text, integer, real, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const timestamp = (name: string) => text(name).default(sql`(datetime('now'))`);

// ── Purchase Orders ──
export const purchaseOrders = sqliteTable("catalog_purchase_orders", {
  id: id(),
  poNumber: text("po_number").unique(),
  supplier: text("supplier"),
  orderDate: text("order_date"),
  shipDate: text("ship_date"),
  factoryCode: text("factory_code"),
  freightType: text("freight_type"),
  shippingMethod: text("shipping_method"),
  notes: text("notes"),
  status: text("status", { enum: ["ordered", "received", "processing", "complete"] }).default("ordered"),
  createdAt: timestamp("created_at"),
});

// ── Purchase Order Items (line items on a PO) ──
export const purchaseOrderItems = sqliteTable("catalog_purchase_order_items", {
  id: id(),
  purchaseOrderId: text("purchase_order_id").references(() => purchaseOrders.id, { onDelete: "cascade" }).notNull(),
  sku: text("sku").notNull(),
  vendorSku: text("vendor_sku"),
  quantity: integer("quantity").notNull(),
  unitPrice: real("unit_price"),
  createdAt: timestamp("created_at"),
});

// ── Operations Exports (audit log for ShipHero + factory CSV exports) ──
export const operationsExports = sqliteTable("operations_exports", {
  id: id(),
  exportType: text("export_type").notNull(),
  filename: text("filename").notNull(),
  rowCount: integer("row_count").notNull(),
  filters: text("filters"),
  createdAt: timestamp("created_at"),
  createdBy: text("created_by"),
});

// ── Products ──
export const products = sqliteTable("catalog_products", {
  id: id(),
  skuPrefix: text("sku_prefix").unique(),
  name: text("name"),
  description: text("description"),
  shortDescription: text("short_description"),
  bulletPoints: text("bullet_points"),
  // category, frame_shape, frame_material, gender, lens_type were dropped —
  // those are now derived from catalog_tags. Use getCuratedAttrs() in
  // src/modules/catalog/lib/curated-attributes.ts to read them.
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
  shipheroSyncedAt: text("shiphero_synced_at"),
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
  url: text("url"),
  fileSize: integer("file_size"),
  mimeType: text("mime_type"),
  checksum: text("checksum"),
  imageTypeId: text("image_type_id").references(() => imageTypes.id),
  position: integer("position").default(0),
  altText: text("alt_text"),
  width: integer("width"),
  height: integer("height"),
  aiModelUsed: text("ai_model_used"),
  aiPrompt: text("ai_prompt"),
  status: text("status", { enum: ["draft", "review", "approved", "rejected"] }).default("draft"),
  isBest: integer("is_best", { mode: "boolean" }).default(false),
  uploadedBy: text("uploaded_by"),
  source: text("source").default("upload"),
  pipelineStatus: text("pipeline_status").default("none"),
  parentImageId: text("parent_image_id"),
  presetId: text("preset_id"),
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

// ── Processing Presets ──
export const processingPresets = sqliteTable("catalog_processing_presets", {
  id: id(),
  name: text("name").notNull().unique(),
  description: text("description"),
  bgRemovalMethod: text("bg_removal_method").default("gemini"),
  bgRemovalParams: text("bg_removal_params"),
  shadowMethod: text("shadow_method").default("none"),
  shadowParams: text("shadow_params"),
  canvasSize: integer("canvas_size").default(2048),
  canvasBg: text("canvas_bg").default("#F8F9FA"),
  canvasPadding: real("canvas_padding").default(0.0),
  outputQuality: integer("output_quality").default(95),
  createdAt: timestamp("created_at"),
});

// ── Image Pipelines ──
export const imagePipelines = sqliteTable("catalog_image_pipelines", {
  id: id(),
  imageId: text("image_id").references(() => images.id, { onDelete: "cascade" }).notNull(),
  stage: text("stage").notNull(),
  method: text("method"),
  methodParams: text("method_params"),
  filePath: text("file_path").notNull(),
  fileSize: integer("file_size"),
  width: integer("width"),
  height: integer("height"),
  checksum: text("checksum"),
  status: text("status", { enum: ["completed", "failed", "pending"] }).default("completed"),
  errorMessage: text("error_message"),
  processingTimeMs: integer("processing_time_ms"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  uniqueIndex("uq_pipeline_image_stage").on(table.imageId, table.stage),
  index("idx_pipeline_image").on(table.imageId),
  index("idx_pipeline_stage").on(table.stage),
]);

// ── Image Variations ──
export const imageVariations = sqliteTable("catalog_image_variations", {
  id: id(),
  imageId: text("image_id").references(() => images.id, { onDelete: "cascade" }).notNull(),
  stage: text("stage").notNull(),
  method: text("method").notNull(),
  methodParams: text("method_params"),
  filePath: text("file_path").notNull(),
  fileSize: integer("file_size"),
  width: integer("width"),
  height: integer("height"),
  label: text("label"),
  isSelected: integer("is_selected").default(0),
  createdAt: timestamp("created_at"),
}, (table) => [
  index("idx_variation_image_stage").on(table.imageId, table.stage),
]);

// ── Collection Images ──
export const collectionImages = sqliteTable("catalog_collection_images", {
  id: id(),
  productId: text("product_id").references(() => products.id, { onDelete: "cascade" }).notNull(),
  filePath: text("file_path").notNull(),
  fileSize: integer("file_size"),
  width: integer("width"),
  height: integer("height"),
  layout: text("layout"),
  variantCount: integer("variant_count"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  uniqueIndex("uq_collection_product").on(table.productId),
]);

// ── Collection Image SKUs (junction table) ──
export const collectionImageSkus = sqliteTable("catalog_collection_image_skus", {
  id: id(),
  collectionImageId: text("collection_image_id").references(() => collectionImages.id, { onDelete: "cascade" }).notNull(),
  skuId: text("sku_id").references(() => skus.id, { onDelete: "cascade" }).notNull(),
  position: integer("position").default(0),
}, (table) => [
  uniqueIndex("uq_collection_sku").on(table.collectionImageId, table.skuId),
]);

// ── Product Listing Images (3-6 curated images per product for Shopify/Faire/Amazon) ──
export const productListingImages = sqliteTable("catalog_product_listing_images", {
  id: id(),
  productId: text("product_id").references(() => products.id, { onDelete: "cascade" }).notNull(),
  imageId: text("image_id").references(() => images.id, { onDelete: "cascade" }).notNull(),
  platform: text("platform").default("all"),
  position: integer("position").default(0),
  createdAt: timestamp("created_at"),
}, (table) => [
  uniqueIndex("uq_listing_product_image_platform").on(table.productId, table.imageId, table.platform),
  index("idx_listing_product_platform").on(table.productId, table.platform),
]);

// Factory map
export const FACTORY_MAP: Record<string, string> = {
  JX1: "TAGA",
  JX2: "HUIDE",
  JX3: "GEYA",
  JX4: "BRILLIANT",
};
