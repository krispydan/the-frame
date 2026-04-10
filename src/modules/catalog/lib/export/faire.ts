/**
 * Faire CSV Export — matches Faire's official product import template.
 *
 * Key design decisions (from FAIRE-CRUSHBOOK / FAIRE-GROWTH-PLAYBOOK):
 * - Product titles are keyword-first then product name, 35–60 chars (Faire SEO rule)
 * - Descriptions lead with retailer margin callout, then specs, then target-customer
 *   callout, then keyword block for Faire search matching
 * - All images must be absolute URLs (1:1 ratio enforced upstream)
 * - Prices: $8 wholesale / $28 retail
 * - Selling method: "By the case", case size 3, MOQ 3
 * - Launch as Draft so we can review in Faire before publishing
 *
 * CSV structure: Faire's template has THREE header rows:
 *   1. Human-readable column labels
 *   2. Mandatory/optional descriptions
 *   3. Machine-readable field keys (what Faire actually parses)
 * Data rows follow, one row per variant (SKU).
 *
 * TODO(compilation-image): Row-level "product_images" currently uses the best
 * SKU image. We want this to be a *compilation* image showing all color variants
 * of the product in one frame (hero image). Build a separate image-compositing
 * step that generates compilation images per skuPrefix and drops them at a
 * predictable URL; then swap this in.
 */
import type { ExportProduct, ProductValidationResult, ValidationIssue } from "./types";
import { catalogImageUrl } from "@/lib/storage/image-url";

// ── Constants ──

const JAXY_WHOLESALE_PRICE = "8.00";
const JAXY_RETAIL_PRICE = "28.00";
const JAXY_CASE_SIZE = "3";
const JAXY_MOQ = "3";
const JAXY_WEIGHT = "0.10";
const JAXY_WEIGHT_UNIT = "lb";
const JAXY_MADE_IN = "China";
const JAXY_HS6 = "900410"; // HS6 code for sunglasses
const JAXY_ON_HAND = "100";

// Faire SEO rule: 35–60 chars
const TITLE_MIN = 35;
const TITLE_MAX = 60;

// ── Faire Template Header Rows (verbatim from Faire's import template) ──

const FAIRE_HEADER_ROW_1 = [
  "Product Name (English)", "Product Status", "Product Token", "Product Type",
  "Description (English)", "Selling Method", "Case Size", "Minimum Order Quantity",
  "Item Weight", "Item Weight Unit", "Item Length", "Item Width", "Item Height",
  "Item Dimensions Unit", "Packaged Weight", "Packaged Weight Unit", "Packaged Length",
  "Packaged Width", "Packaged Height", "Packaged Dimensions Unit", "Option Status",
  "SKU", "GTIN", "Option 1 Name", "Option 1 Value", "Option 2 Name", "Option 2 Value",
  "Option 3 Name", "Option 3 Value", "USD Unit Wholesale Price", "USD Unit Retail Price",
  "CAD Unit Wholesale Price", "CAD Unit Retail Price", "GBR Unit Wholesale Price",
  "GBR Unit Retail Price", "EUR Unit Wholesale Price", "EUR Unit Retail Price",
  "AUD Unit Wholesale Price", "AUD Unit Retail Price", "Option Image", "Preorder",
  "Ship By Date (YYYY-MM-DD)", "Ship By End Date (if range, YYYY-MM-DD)",
  "Deadline To Order (YYYY-MM-DD)", "Sell After Order By/Ship Date", "Product Images",
  "Made In Country", "Tester Price (USD)", "Tester Price (CAD)", "Tester Price (GBP)",
  "Tester Price (EUR)", "Tester Price (AUD)", "Customizable", "Customization Instructions",
  "Customization Input Required", "Customization Input Character Limit",
  "Customization Minimum Order Quantity", "Customization Charge Per Unit (USD)",
  "Customization Charge Per Unit (CAD)", "Customization Charge Per Unit (GBP)",
  "Customization Charge Per Unit (EUR)", "Customization Charge Per Unit (AUD)",
  "Continue selling when out of stock", "On Hand Inventory", "On Hand Inventory (Read Only)",
  "Restock Date", "HS6 Tariff Code",
];

const FAIRE_HEADER_ROW_2 = [
  "Mandatory", "Optional, defaults to Published",
  "Do not edit for exported products. Leave blank for new products.", "Optional", "Optional",
  "Mandatory", "Mandatory if selling by the case. Leave blank for \"By the item\" or \"Open sizing\".",
  "Mandatory", "Optional", "Mandatory if item weight is provided. Select between kg, g, lb, or oz",
  "Optional", "Optional", "Optional",
  "Mandatory if item dimensions are provided. Select between cm or in", "Optional",
  "Mandatory if packaged weight is provided. Select between kg, g, lb, or oz", "Optional",
  "Optional", "Optional",
  "Mandatory if packaged dimensions are provided. Select between cm or in",
  "Optional, defaults to Published", "Optional", "Optional", "Optional",
  "Mandatory if Option 1 Name is filled", "Optional", "Mandatory if Option 2 Name is filled",
  "Optional", "Mandatory if Option 3 Name is filled", "Mandatory", "Mandatory", "Optional",
  "Optional", "Optional", "Optional", "Optional", "Optional", "Optional", "Optional", "Optional",
  "Optional", "Mandatory if Preorder", "Optional if Preorder", "Optional if Preorder",
  "Optional if Preorder",
  "Mandatory for at least 1 row per product, and should contain at least 1 URL or image filename",
  "Optional", "Optional, defaults to blank which means there is not a tester",
  "Optional, defaults to blank which means there is not a tester",
  "Optional, defaults to blank which means there is not a tester",
  "Optional, defaults to blank which means there is not a tester",
  "Optional, defaults to blank which means there is not a tester", "Optional, default to No",
  "Mandatory for products with customizations", "Optional, default to No",
  "Mandatory for products with customizations", "Mandatory for products with customizations",
  "Optional, default to $0.00", "Optional, default to $0.00", "Optional, default to £0.00",
  "Optional, default to €0.00", "Optional, default to $0.00", "Optional", "Optional", "Optional",
  "Optional", "Optional",
];

const FAIRE_FIELD_KEYS = [
  "product_name_english", "info_status_v2", "info_product_token", "info_product_type",
  "product_description_english", "selling_method", "case_quantity", "minimum_order_quantity",
  "item_weight", "item_weight_unit", "item_length", "item_width", "item_height",
  "item_dimensions_unit", "packaged_weight", "packaged_weight_unit", "packaged_length",
  "packaged_width", "packaged_height", "packaged_dimensions_unit", "option_status", "sku",
  "gtin", "option_1_name", "option_1_value", "option_2_name", "option_2_value",
  "option_3_name", "option_3_value", "price_wholesale", "price_retail",
  "canadian_price_wholesale", "canadian_price_retail", "uk_price_wholesale", "uk_price_retail",
  "eu_price_wholesale", "eu_price_retail", "australian_price_wholesale",
  "australian_price_retail", "option_image", "preorderable", "ship_by_start_date",
  "ship_by_end_date", "order_by_date", "keep_active", "product_images", "made_in_country",
  "tester_price", "canadian_tester_price", "uk_tester_price", "eu_tester_price",
  "australian_tester_price", "has_customization", "customization_instructions",
  "customization_input_required", "customization_input_limit", "customization_moq",
  "customization_charge", "canadian_customization_charge", "uk_customization_charge",
  "eu_customization_charge", "australian_customization_charge",
  "continue_selling_when_out_of_stock", "on_hand_inventory", "on_hand_inventory_original",
  "restock_date", "tariff_code",
];

// ── CSV Helpers ──

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function absoluteImageUrl(filePath: string | null): string {
  return catalogImageUrl(filePath) ?? "";
}

// ── Tag/attribute extraction ──

const SHAPE_TAGS = [
  "cat-eye", "cat eye", "aviator", "round", "square", "rectangle", "rectangular",
  "oval", "wayfarer", "shield", "oversized", "rimless", "geometric", "hexagonal",
  "butterfly", "browline",
];

const STYLE_TAGS = [
  "vintage", "retro", "classic", "modern", "bold", "trendy", "chic", "minimalist",
  "y2k", "90s", "70s", "80s", "statement", "boho", "preppy",
];

function getTagSet(ep: ExportProduct): Set<string> {
  return new Set(
    ep.tags
      .map((t) => t.tagName?.toLowerCase().trim())
      .filter((t): t is string => Boolean(t)),
  );
}

function detectFrameShape(ep: ExportProduct, tagSet: Set<string>): string | null {
  // Prefer explicit tag, fall back to frameShape field
  for (const shape of SHAPE_TAGS) {
    if (tagSet.has(shape)) return shape === "cat eye" ? "cat-eye" : shape;
  }
  const fs = ep.product.frameShape?.toLowerCase().trim();
  if (fs && SHAPE_TAGS.includes(fs)) return fs;
  return null;
}

function detectStyleAdjective(tagSet: Set<string>): string | null {
  for (const style of STYLE_TAGS) {
    if (tagSet.has(style)) return style;
  }
  return null;
}

function isPolarized(ep: ExportProduct, tagSet: Set<string>): boolean {
  return tagSet.has("polarized") || ep.product.frameShape?.toLowerCase() === "polarized";
}

function formatShape(shape: string): string {
  if (shape === "cat-eye") return "Cat-Eye";
  if (shape === "rectangular") return "Rectangle";
  return capitalize(shape);
}

function genderPhrase(gender: string | null): string {
  const g = gender?.toLowerCase().trim();
  if (g === "women" || g === "womens" || g === "women's") return "for Women";
  if (g === "men" || g === "mens" || g === "men's") return "for Men";
  if (g === "unisex") return "for Women & Men";
  return "for Women & Men"; // safe default
}

function mapFaireProductType(gender: string | null): string {
  const g = gender?.toLowerCase().trim();
  if (g === "women" || g === "womens" || g === "women's") return "Sunglasses - Women's";
  if (g === "men" || g === "mens" || g === "men's") return "Sunglasses - Men's";
  return "Sunglasses - Unisex";
}

// ── Title Builder ──

/**
 * Build a keyword-first Faire product title, 35–60 chars.
 *
 * Formula: [Style?] [Polarized?] [Shape] Sunglasses [for Women/Men/Both] - [Name]
 * Falls back gracefully if title would exceed 60 chars.
 */
export function buildFaireTitle(ep: ExportProduct): string {
  const name = (ep.product.name || ep.product.skuPrefix).trim();
  const tagSet = getTagSet(ep);

  const style = detectStyleAdjective(tagSet);
  const shape = detectFrameShape(ep, tagSet);
  const polar = isPolarized(ep, tagSet);
  const gPhrase = genderPhrase(ep.product.gender);

  const keywordParts: string[] = [];
  if (style) keywordParts.push(capitalize(style));
  if (polar) keywordParts.push("Polarized");
  if (shape) keywordParts.push(formatShape(shape));
  keywordParts.push("Sunglasses");

  // Try full version first
  let title = `${keywordParts.join(" ")} ${gPhrase} - ${name}`;
  if (title.length <= TITLE_MAX) return title.length < TITLE_MIN ? padTitle(title, name) : title;

  // Drop gender phrase
  title = `${keywordParts.join(" ")} - ${name}`;
  if (title.length <= TITLE_MAX) return title;

  // Drop style adjective
  const noStyle = keywordParts.filter((p) => p !== capitalize(style || ""));
  title = `${noStyle.join(" ")} - ${name}`;
  if (title.length <= TITLE_MAX) return title;

  // Last resort: truncate name
  const budget = TITLE_MAX - (noStyle.join(" ").length + 3);
  return `${noStyle.join(" ")} - ${name.slice(0, Math.max(1, budget))}`;
}

function padTitle(title: string, name: string): string {
  // Already has "Sunglasses" — add descriptive adjective if < 35 chars
  if (title.length >= TITLE_MIN) return title;
  const padded = title.replace(" Sunglasses", " Retro Sunglasses");
  if (padded.length <= TITLE_MAX) return padded;
  return title;
}

// ── Description Builder ──

/**
 * Build a Faire description using the real catalog description and appending
 * a keyword block. Structure:
 *
 * 1. Real product description (from ep.product.description, HTML stripped).
 *    Falls back to a minimal one-liner only if the catalog description is empty.
 * 2. Tag sentence — the product's tags expressed as a natural sentence
 *    ("Features vintage, cat-eye, and polarized styling.")
 * 3. Keywords: plain comma-separated list of top Faire search terms for this
 *    product, matched against Jaxy's Faire search-trend data.
 *
 * TODO: Add bridge/lens-width/temple sizing measurements once we capture that
 * data in the catalog. Faire rep (3/5/26) confirmed sizing info is essential
 * for eyewear listings.
 */
export function buildFaireDescription(ep: ExportProduct): string {
  const parts: string[] = [];

  // 1. Real product description (HTML stripped), with fallback
  const real = ep.product.description
    ? stripHtml(ep.product.description)
    : ep.product.shortDescription
      ? stripHtml(ep.product.shortDescription)
      : "";
  parts.push(
    real ||
      "Jaxy sunglasses featuring UV400 lens protection and impact-resistant polycarbonate lenses. Cases sold separately.",
  );

  // 2. Tags as a natural sentence (not a list)
  const tagSentence = buildTagSentence(ep);
  if (tagSentence) parts.push(tagSentence);

  // 3. Keywords — plain comma-separated list
  parts.push(buildKeywordLine(ep));

  return parts.join("\n\n");
}

function buildTagSentence(ep: ExportProduct): string {
  const tagSet = getTagSet(ep);
  if (tagSet.size === 0) return "";
  const tags = Array.from(tagSet);
  if (tags.length === 1) return `Features ${tags[0]} styling.`;
  if (tags.length === 2) return `Features ${tags[0]} and ${tags[1]} styling.`;
  const rest = tags.slice(0, -1).join(", ");
  const last = tags[tags.length - 1];
  return `Features ${rest}, and ${last} styling.`;
}

function buildKeywordLine(ep: ExportProduct): string {
  const tagSet = getTagSet(ep);
  const style = detectStyleAdjective(tagSet);
  const shape = detectFrameShape(ep, tagSet);
  const polar = isPolarized(ep, tagSet);
  const gender = ep.product.gender?.toLowerCase().trim();

  const base = [
    "sunglasses",
    "wholesale sunglasses",
    "designer sunglasses",
    "trendy sunglasses",
    "boutique eyewear",
  ];
  if (gender === "women" || gender === "womens" || gender === "women's") {
    base.push("womens sunglasses", "sunglasses women", "women's sunglasses");
  } else if (gender === "men" || gender === "mens" || gender === "men's") {
    base.push("mens sunglasses", "sunglasses men", "men's sunglasses");
  } else {
    base.push("womens sunglasses", "mens sunglasses", "unisex sunglasses");
  }
  if (shape) {
    const s = shape === "cat-eye" ? "cat eye" : shape;
    base.push(`${s} sunglasses`, `${s} sunglasses women`);
  }
  if (polar) base.push("polarized sunglasses", "polarized sunglasses women");
  if (style) base.push(`${style} sunglasses`);
  // Evergreen high-volume Faire search terms
  base.push("retro sunglasses", "vintage sunglasses", "aviator sunglasses", "oversized sunglasses");

  // Dedupe while preserving order
  const seen = new Set<string>();
  const out = base.filter((k) => {
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return `Keywords: ${out.join(", ")}.`;
}

// ── Validation ──

function worstSeverity(issues: ValidationIssue[]): "ready" | "blocked" | "warning" {
  if (issues.some((i) => i.severity === "blocked")) return "blocked";
  if (issues.some((i) => i.severity === "warning")) return "warning";
  return "ready";
}

export function validateForFaire(product: ExportProduct): ProductValidationResult {
  const issues: ValidationIssue[] = [];
  const generatedTitle = buildFaireTitle(product);
  if (!product.product.name) {
    issues.push({ field: "name", message: "Product name is required", severity: "blocked" });
  }
  if (generatedTitle.length > TITLE_MAX) {
    issues.push({
      field: "title",
      message: `Generated title exceeds ${TITLE_MAX} chars (${generatedTitle.length})`,
      severity: "warning",
    });
  }
  if (generatedTitle.length < TITLE_MIN) {
    issues.push({
      field: "title",
      message: `Generated title is under Faire's ${TITLE_MIN}-char minimum (${generatedTitle.length})`,
      severity: "warning",
    });
  }
  if (product.skus.length === 0) {
    issues.push({ field: "skus", message: "No SKUs found", severity: "blocked" });
  }
  const approvedImages = product.images.filter((i) => i.filePath);
  if (approvedImages.length === 0) {
    issues.push({ field: "images", message: "At least one image required", severity: "blocked" });
  }

  return {
    productId: product.product.id,
    productName: generatedTitle || product.product.skuPrefix,
    skuPrefix: product.product.skuPrefix,
    status: worstSeverity(issues),
    issues,
    skuResults: [],
  };
}

// ── CSV Generator ──

interface FaireRow {
  product_name_english: string;
  info_status_v2: string;
  info_product_token: string;
  info_product_type: string;
  product_description_english: string;
  selling_method: string;
  case_quantity: string;
  minimum_order_quantity: string;
  item_weight: string;
  item_weight_unit: string;
  item_length: string;
  item_width: string;
  item_height: string;
  item_dimensions_unit: string;
  packaged_weight: string;
  packaged_weight_unit: string;
  packaged_length: string;
  packaged_width: string;
  packaged_height: string;
  packaged_dimensions_unit: string;
  option_status: string;
  sku: string;
  gtin: string;
  option_1_name: string;
  option_1_value: string;
  option_2_name: string;
  option_2_value: string;
  option_3_name: string;
  option_3_value: string;
  price_wholesale: string;
  price_retail: string;
  canadian_price_wholesale: string;
  canadian_price_retail: string;
  uk_price_wholesale: string;
  uk_price_retail: string;
  eu_price_wholesale: string;
  eu_price_retail: string;
  australian_price_wholesale: string;
  australian_price_retail: string;
  option_image: string;
  preorderable: string;
  ship_by_start_date: string;
  ship_by_end_date: string;
  order_by_date: string;
  keep_active: string;
  product_images: string;
  made_in_country: string;
  tester_price: string;
  canadian_tester_price: string;
  uk_tester_price: string;
  eu_tester_price: string;
  australian_tester_price: string;
  has_customization: string;
  customization_instructions: string;
  customization_input_required: string;
  customization_input_limit: string;
  customization_moq: string;
  customization_charge: string;
  canadian_customization_charge: string;
  uk_customization_charge: string;
  eu_customization_charge: string;
  australian_customization_charge: string;
  continue_selling_when_out_of_stock: string;
  on_hand_inventory: string;
  on_hand_inventory_original: string;
  restock_date: string;
  tariff_code: string;
}

function blankRow(): FaireRow {
  const obj: Record<string, string> = {};
  for (const key of FAIRE_FIELD_KEYS) obj[key] = "";
  return obj as unknown as FaireRow;
}

function rowToValues(row: FaireRow): string[] {
  return FAIRE_FIELD_KEYS.map((k) => (row as unknown as Record<string, string>)[k] ?? "");
}

export function generateFaireCsv(exportProducts: ExportProduct[]): string {
  const lines: string[] = [];

  // Three header rows verbatim
  lines.push(FAIRE_HEADER_ROW_1.map(escapeCsvField).join(","));
  lines.push(FAIRE_HEADER_ROW_2.map(escapeCsvField).join(","));
  lines.push(FAIRE_FIELD_KEYS.map(escapeCsvField).join(","));

  for (const ep of exportProducts) {
    if (ep.skus.length === 0) continue;

    const title = buildFaireTitle(ep);
    const description = buildFaireDescription(ep);
    const productType = mapFaireProductType(ep.product.gender);

    // TODO(compilation-image): replace with a generated compilation image that
    // shows all color variants of this product in one frame (hero image).
    // For now we use the best approved image across the whole product.
    const productHeroImage = pickBestImage(ep);

    for (const sku of ep.skus) {
      // Best image for this specific variant (approved first, isBest first)
      const variantImg = ep.images
        .filter((i) => i.skuId === sku.id && i.filePath)
        .sort((a, b) => {
          if (a.status === "approved" && b.status !== "approved") return -1;
          if (b.status === "approved" && a.status !== "approved") return 1;
          return (b.isBest ? 1 : 0) - (a.isBest ? 1 : 0);
        })[0];
      const optionImageUrl = absoluteImageUrl(variantImg?.filePath || null);

      const row = blankRow();
      row.product_name_english = title;
      row.info_status_v2 = "Draft"; // launch as Draft, publish after review
      row.info_product_token = ""; // blank for new products
      row.info_product_type = productType;
      row.product_description_english = description;
      row.selling_method = "By the case";
      row.case_quantity = JAXY_CASE_SIZE;
      row.minimum_order_quantity = JAXY_MOQ;
      row.item_weight = JAXY_WEIGHT;
      row.item_weight_unit = JAXY_WEIGHT_UNIT;
      row.option_status = "Published";
      row.sku = sku.sku || "";
      row.gtin = sku.upc || "";
      row.option_1_name = "Color";
      row.option_1_value = sku.colorName || "Default";
      row.price_wholesale = JAXY_WHOLESALE_PRICE;
      row.price_retail = JAXY_RETAIL_PRICE;
      row.option_image = optionImageUrl;
      row.product_images = productHeroImage || optionImageUrl;
      row.made_in_country = JAXY_MADE_IN;
      row.has_customization = "No";
      row.continue_selling_when_out_of_stock = "Yes";
      row.on_hand_inventory = JAXY_ON_HAND;
      row.tariff_code = JAXY_HS6;

      lines.push(rowToValues(row).map(escapeCsvField).join(","));
    }
  }

  return lines.join("\n");
}

function pickBestImage(ep: ExportProduct): string {
  const best = ep.images
    .filter((i) => i.filePath)
    .sort((a, b) => {
      if (a.status === "approved" && b.status !== "approved") return -1;
      if (b.status === "approved" && a.status !== "approved") return 1;
      return (b.isBest ? 1 : 0) - (a.isBest ? 1 : 0);
    })[0];
  return absoluteImageUrl(best?.filePath || null);
}
