/**
 * Shopify CSV Export — ported from ~/jaxy-catalog-tool/src/lib/export/shopify.ts
 */
import type { ExportProduct, ValidationIssue, ProductValidationResult } from "./types";
import Papa from "papaparse";

const SHAPE_TAGS = new Set(["aviator", "cat-eye", "round", "square", "oversized", "rectangle", "wayfarer", "oval", "geometric"]);
const STYLE_TAGS = new Set(["retro", "vintage", "classic", "modern", "bold", "statement", "timeless", "trendy"]);

// Constant fields every Jaxy product shares
const JAXY_CONSTANTS = {
  productCategory: "Apparel & Accessories > Clothing Accessories > Sunglasses",
  ageGroup: "adults",
  hsCode: "9004.10",
  countryOfOrigin: "CN",
} as const;

/**
 * Map a Jaxy color name to Shopify's controlled vocab for
 * `shopify.color-pattern` and `shopify.eyewear-frame-color`.
 * Defaults to lowercased input so custom colors still round-trip.
 */
function normalizeShopifyColor(colorName: string | null): string {
  if (!colorName) return "";
  const c = colorName.toLowerCase().trim();
  const map: Record<string, string> = {
    "tortoise": "brown",
    "tortoiseshell": "brown",
    "tor": "brown",
    "brw": "brown",
    "blk": "black",
    "wht": "white",
    "grn": "green",
    "blu": "blue",
    "red": "red",
    "gld": "gold",
    "slv": "silver",
    "olv": "green",
    "ylw": "yellow",
    "pnk": "pink",
    "amb": "orange",
    "snd": "beige",
    "rst": "orange",
    "tea": "green",
    "gry": "gray",
    "bur": "purple",
  };
  return map[c] ?? c;
}

function mapLensPolarization(tagsByDim: Map<string, string[]>): string {
  const lensTags = (tagsByDim.get("lens") ?? []).map((t) => t.toLowerCase());
  return lensTags.includes("polarized") ? "polarized" : "non-polarized";
}

function buildSeoAltText(productName: string, colorName: string | null, tagNames: string[], imageIndex: number, totalImages: number): string {
  const tagSet = new Set(tagNames.map((t) => t.toLowerCase()));
  const shape = tagNames.find((t) => SHAPE_TAGS.has(t.toLowerCase()))?.toLowerCase() || "";
  const style = tagNames.find((t) => STYLE_TAGS.has(t.toLowerCase()))?.toLowerCase() || "";
  const isPolarized = tagSet.has("polarized");
  const isWomens = tagSet.has("womens");
  const parts = [`Jaxy ${productName}${colorName ? ` ${colorName}` : ""}`];
  const descriptors: string[] = [];
  if (isWomens) descriptors.push("women's");
  if (isPolarized) descriptors.push("polarized");
  if (shape) descriptors.push(shape);
  descriptors.push("sunglasses");
  if (style) descriptors.push(`${style} style`);
  parts.push(descriptors.join(" "));
  if (totalImages > 1) parts.push(["front view", "angle view", "detail view"][Math.min(imageIndex, 2)]);
  return parts.join(" - ");
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export type ShopifyChannel = "retail" | "wholesale";

export function validateProductsForShopify(exportProducts: ExportProduct[], channel: ShopifyChannel = "retail"): ProductValidationResult[] {
  return exportProducts.map((ep) => {
    const issues: ValidationIssue[] = [];
    if (!ep.product.name?.trim()) issues.push({ field: "name", message: "Product name is required", severity: "blocked" });
    if (!ep.product.description?.trim()) issues.push({ field: "description", message: "Product description is required", severity: "blocked" });
    if (ep.skus.length === 0) issues.push({ field: "skus", message: "At least one SKU is required", severity: "blocked" });
    if (!ep.retailPrice) issues.push({ field: "retailPrice", message: "Retail price is required", severity: "blocked" });
    if (channel === "wholesale" && !ep.wholesalePrice) issues.push({ field: "wholesalePrice", message: "Wholesale price required", severity: "blocked" });
    const hasApproved = ep.images.some((i) => i.status === "approved");
    if (!hasApproved) issues.push({ field: "images", message: "At least one approved image required", severity: "blocked" });
    if (!ep.product.category) issues.push({ field: "category", message: "Category is not set", severity: "warning" });
    const hasError = issues.some((i) => i.severity === "blocked");
    const hasWarning = issues.some((i) => i.severity === "warning");
    return {
      productId: ep.product.id, productName: ep.product.name || ep.product.skuPrefix,
      skuPrefix: ep.product.skuPrefix,
      status: hasError ? "blocked" : hasWarning ? "warning" : "ready",
      issues, skuResults: [],
    };
  });
}

type ExportImage = ExportProduct["images"][number];

const EXTRA_ANGLES_FOR_MAIN_SKU = ["side", "other-side", "top"] as const;

function isLifestyleImage(img: ExportImage): boolean {
  const slug = img.imageTypeSlug ?? "";
  return slug.startsWith("lifestyle") || slug.startsWith("studio-");
}

/**
 * Build the Shopify image list for one product, in display order:
 *   1. Collection composite (product-level hero, if present)
 *   2. For each SKU: that SKU's square + front image (color swatch)
 *   3. For the first SKU only: side, other-side, top squares (product detail angles)
 *   4. Lifestyle / studio-* images (any SKU) if present
 *
 * Returns the ordered list and a per-SKU → front-image map used to
 * populate Shopify's "Variant Image" column so color-swatch selection
 * swaps to the right photo natively.
 *
 * Exported so the validator can stat exactly the files the CSV would
 * reference (and nothing extra).
 */
export function buildShopifyImageList(ep: ExportProduct): {
  productImages: ExportImage[];
  frontBySkuId: Map<string, ExportImage>;
} {
  const approved = ep.images.filter((i) => i.status === "approved" && i.filePath);

  const productImages: ExportImage[] = [];

  // 1. Collection composite
  const collection = approved.find((i) => i.source === "collection");
  if (collection) productImages.push(collection);

  // 2. Per-SKU front (also used as Variant Image)
  const frontBySkuId = new Map<string, ExportImage>();
  for (const sku of ep.skus) {
    const front = approved.find(
      (i) => i.skuId === sku.id && i.source === "square" && i.imageTypeSlug === "front",
    );
    if (front) {
      frontBySkuId.set(sku.id, front);
      productImages.push(front);
    }
  }

  // 3. First SKU's other angles (product detail views)
  const firstSku = ep.skus[0];
  if (firstSku) {
    for (const angle of EXTRA_ANGLES_FOR_MAIN_SKU) {
      const img = approved.find(
        (i) => i.skuId === firstSku.id && i.source === "square" && i.imageTypeSlug === angle,
      );
      if (img) productImages.push(img);
    }
  }

  // 4. Lifestyle / studio scene images (any source, any SKU)
  for (const img of approved) {
    if (isLifestyleImage(img) && !productImages.includes(img)) {
      productImages.push(img);
    }
  }

  return { productImages, frontBySkuId };
}

export function generateShopifyCSV(exportProducts: ExportProduct[], channel: ShopifyChannel = "retail"): string {
  const rows: Record<string, string>[] = [];

  for (const ep of exportProducts) {
    const handle = slugify(ep.product.name || ep.product.skuPrefix || ep.product.id);
    const tagString = ep.tags.map((t) => t.tagName).filter(Boolean).join(", ");
    const tagNames = ep.tags.map((t) => t.tagName).filter(Boolean) as string[];
    const lensTag = ep.tags.find((t) => t.dimension === "lens")?.tagName || "";

    // Group tags by dimension for easier lookup
    const tagsByDim = new Map<string, string[]>();
    for (const t of ep.tags) {
      if (!t.dimension || !t.tagName) continue;
      const arr = tagsByDim.get(t.dimension) ?? [];
      arr.push(t.tagName);
      tagsByDim.set(t.dimension, arr);
    }

    // Product-level Shopify standard metafields (only set on the first row)
    const gender = (ep.product.gender || "unisex").toLowerCase();
    const frameShape = (ep.product.frameShape || "").toLowerCase();
    // color-pattern: unique list of normalized SKU colors
    const colorSet = new Set<string>();
    for (const sku of ep.skus) {
      const norm = normalizeShopifyColor(sku.colorName);
      if (norm) colorSet.add(norm);
    }
    const colorPattern = Array.from(colorSet).join("; ");
    const polarization = mapLensPolarization(tagsByDim);

    const { productImages, frontBySkuId } = buildShopifyImageList(ep);

    const variantPrice = channel === "wholesale"
      ? ((ep.wholesalePrice && ep.wholesalePrice > 0) ? ep.wholesalePrice.toFixed(2) : "8.00")
      : ((ep.retailPrice && ep.retailPrice > 0) ? ep.retailPrice.toFixed(2) : "24.00");
    const compareAtPrice = channel === "wholesale"
      ? ((ep.retailPrice && ep.retailPrice > 0) ? ep.retailPrice.toFixed(2) : "")
      : ((ep.msrp && ep.msrp > 0) ? ep.msrp.toFixed(2) : "");

    const firstSku = ep.skus[0];
    const firstImage = productImages[0];
    const firstVariantImage = firstSku ? frontBySkuId.get(firstSku.id) : undefined;
    const firstSkuColor = normalizeShopifyColor(firstSku?.colorName ?? null);

    rows.push({
      Handle: handle, Title: ep.product.name || "", "Body (HTML)": ep.product.description || "",
      Vendor: "Jaxy",
      "Product Category": JAXY_CONSTANTS.productCategory,
      Type: ep.product.category || "Sunglasses",
      Tags: tagString, Published: "TRUE",
      "Option1 Name": ep.skus.length > 1 ? "Color" : "Title",
      "Option1 Value": firstSku?.colorName || "Default Title",
      "Variant SKU": firstSku?.sku || "",
      "Variant Inventory Tracker": "shopify",
      "Variant Inventory Policy": "continue",
      "Variant Fulfillment Service": "manual",
      "Variant Price": variantPrice,
      "Variant Compare At Price": compareAtPrice,
      "Variant Requires Shipping": "true",
      "Variant Taxable": "true",
      "Variant HS Code": JAXY_CONSTANTS.hsCode,
      "Variant Country of Origin": JAXY_CONSTANTS.countryOfOrigin,
      "Variant Image": firstVariantImage?.filePath || "",
      "Variant Weight Unit": "oz",
      "Image Src": firstImage?.filePath || "", "Image Position": firstImage ? "1" : "",
      "Image Alt Text": firstImage ? buildSeoAltText(ep.product.name || "", firstSku?.colorName || null, tagNames, 0, productImages.length) : "",
      "SEO Title": ep.product.name || "", "SEO Description": ep.product.shortDescription || "",
      Status: "active",
      "Metafield: custom.lens_type [single_line_text_field]": lensTag,
      "Age group (product.metafields.shopify.age-group)": JAXY_CONSTANTS.ageGroup,
      "Color (product.metafields.shopify.color-pattern)": colorPattern,
      "Eyewear frame color (product.metafields.shopify.eyewear-frame-color)": firstSkuColor,
      "Eyewear frame design (product.metafields.shopify.eyewear-frame-design)": frameShape,
      "Lens color (product.metafields.shopify.lens-color)": firstSkuColor,
      "Lens polarization (product.metafields.shopify.lens-polarization)": polarization,
      "Target gender (product.metafields.shopify.target-gender)": gender,
    });

    for (let i = 1; i < ep.skus.length; i++) {
      const sku = ep.skus[i];
      const variantImage = frontBySkuId.get(sku.id);
      rows.push({
        Handle: handle, Title: "", "Body (HTML)": "", Vendor: "",
        "Product Category": "",
        Type: "", Tags: "", Published: "",
        "Option1 Name": "", "Option1 Value": sku.colorName || "",
        "Variant SKU": sku.sku || "",
        "Variant Inventory Tracker": "shopify",
        "Variant Inventory Policy": "continue",
        "Variant Fulfillment Service": "manual",
        "Variant Price": variantPrice,
        "Variant Compare At Price": compareAtPrice,
        "Variant Requires Shipping": "true",
        "Variant Taxable": "true",
        "Variant HS Code": JAXY_CONSTANTS.hsCode,
        "Variant Country of Origin": JAXY_CONSTANTS.countryOfOrigin,
        "Variant Image": variantImage?.filePath || "",
        "Variant Weight Unit": "oz",
        "Image Src": "", "Image Position": "", "Image Alt Text": "", "SEO Title": "", "SEO Description": "",
        Status: "",
        "Metafield: custom.lens_type [single_line_text_field]": "",
        "Age group (product.metafields.shopify.age-group)": "",
        "Color (product.metafields.shopify.color-pattern)": "",
        "Eyewear frame color (product.metafields.shopify.eyewear-frame-color)": "",
        "Eyewear frame design (product.metafields.shopify.eyewear-frame-design)": "",
        "Lens color (product.metafields.shopify.lens-color)": "",
        "Lens polarization (product.metafields.shopify.lens-polarization)": "",
        "Target gender (product.metafields.shopify.target-gender)": "",
      });
    }

    for (let i = 1; i < productImages.length; i++) {
      rows.push({
        Handle: handle, Title: "", "Body (HTML)": "", Vendor: "",
        "Product Category": "",
        Type: "", Tags: "", Published: "",
        "Option1 Name": "", "Option1 Value": "", "Variant SKU": "",
        "Variant Inventory Tracker": "",
        "Variant Inventory Policy": "",
        "Variant Fulfillment Service": "",
        "Variant Price": "",
        "Variant Compare At Price": "",
        "Variant Requires Shipping": "",
        "Variant Taxable": "",
        "Variant HS Code": "",
        "Variant Country of Origin": "",
        "Variant Image": "",
        "Variant Weight Unit": "",
        "Image Src": productImages[i].filePath || "", "Image Position": String(i + 1),
        "Image Alt Text": buildSeoAltText(ep.product.name || "", null, tagNames, i, productImages.length),
        "SEO Title": "", "SEO Description": "",
        Status: "",
        "Metafield: custom.lens_type [single_line_text_field]": "",
        "Age group (product.metafields.shopify.age-group)": "",
        "Color (product.metafields.shopify.color-pattern)": "",
        "Eyewear frame color (product.metafields.shopify.eyewear-frame-color)": "",
        "Eyewear frame design (product.metafields.shopify.eyewear-frame-design)": "",
        "Lens color (product.metafields.shopify.lens-color)": "",
        "Lens polarization (product.metafields.shopify.lens-polarization)": "",
        "Target gender (product.metafields.shopify.target-gender)": "",
      });
    }
  }

  return Papa.unparse(rows, { header: true });
}
