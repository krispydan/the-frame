/**
 * Amazon TSV Export — ported from ~/jaxy-catalog-tool/src/lib/export/amazon.ts
 */
import type { ExportProduct, ProductValidationResult, ValidationIssue } from "./types";

function worstSeverity(issues: ValidationIssue[]): "ready" | "blocked" | "warning" {
  if (issues.some((i) => i.severity === "blocked")) return "blocked";
  if (issues.some((i) => i.severity === "warning")) return "warning";
  return "ready";
}

function parseBulletPoints(bp: string | null): string[] {
  if (!bp) return [];
  try { const parsed = JSON.parse(bp); if (Array.isArray(parsed)) return parsed.filter((s: string) => s?.trim()); } catch {}
  return bp.split("\n").filter((s) => s.trim());
}

export function validateForAmazon(product: ExportProduct): ProductValidationResult {
  const issues: ValidationIssue[] = [];
  if (!product.product.name) issues.push({ field: "name", message: "Product name is required", severity: "blocked" });
  if (!product.product.description) issues.push({ field: "description", message: "Product description is missing", severity: "warning" });
  const bullets = parseBulletPoints(product.product.bulletPoints);
  if (bullets.length < 5) issues.push({ field: "bulletPoints", message: `Need 5 bullet points, have ${bullets.length}`, severity: "blocked" });
  if (!product.retailPrice && !product.msrp) issues.push({ field: "price", message: "Retail price/MSRP required", severity: "blocked" });
  if (product.skus.length === 0) issues.push({ field: "skus", message: "No SKUs found", severity: "blocked" });
  const skusWithoutUpc = product.skus.filter((s) => !s.upc);
  if (skusWithoutUpc.length > 0) issues.push({ field: "upc", message: `${skusWithoutUpc.length} SKU(s) missing UPC`, severity: "blocked" });

  return {
    productId: product.product.id, productName: product.product.name || product.product.skuPrefix,
    skuPrefix: product.product.skuPrefix, status: worstSeverity(issues), issues, skuResults: [],
  };
}

const AMAZON_HEADERS = [
  "item_sku", "external_product_id", "external_product_id_type", "item_name", "brand_name",
  "manufacturer", "product_description", "bullet_point1", "bullet_point2", "bullet_point3",
  "bullet_point4", "bullet_point5", "standard_price", "quantity", "main_image_url",
  "other_image_url1", "other_image_url2", "other_image_url3", "other_image_url4",
  "color_name", "color_map", "size_name", "frame_material_type", "department_name",
  "item_type_keyword", "style_keyword", "parent_child", "parent_sku", "relationship_type", "variation_theme",
];

function escTsv(value: string): string { return value.replace(/\t/g, " ").replace(/[\n\r]/g, " "); }
function stripHtml(html: string): string { return html.replace(/<[^>]*>/g, "").trim(); }

function mapDepartment(gender: string | null): string {
  switch (gender?.toLowerCase()) { case "men": case "male": return "mens"; case "women": case "female": return "womens"; default: return "unisex-adult"; }
}

function mapItemType(category: string | null): string {
  switch (category) { case "sunglasses": return "sunglasses"; case "optical": return "eyeglass-frames"; case "reading": return "reading-glasses"; default: return "sunglasses"; }
}

function mapColorMap(colorName: string | null): string {
  if (!colorName) return "";
  const lower = colorName.toLowerCase();
  const m: Record<string, string> = { black: "Black", brown: "Brown", tortoise: "Brown", gold: "Gold", silver: "Silver", blue: "Blue", green: "Green", red: "Red", pink: "Pink", white: "White", grey: "Grey", gray: "Grey", clear: "Transparent", purple: "Purple" };
  for (const [k, v] of Object.entries(m)) { if (lower.includes(k)) return v; }
  return "Multicolour";
}

export function generateAmazonTsv(exportProducts: ExportProduct[]): string {
  const lines: string[] = [AMAZON_HEADERS.join("\t")];

  for (const ep of exportProducts) {
    const bullets = parseBulletPoints(ep.product.bulletPoints);
    const description = ep.product.description ? stripHtml(ep.product.description) : "";
    const price = ((ep.retailPrice && ep.retailPrice > 0 ? ep.retailPrice : null) || (ep.msrp && ep.msrp > 0 ? ep.msrp : null) || 24).toFixed(2);
    const department = mapDepartment(ep.product.gender);
    const itemType = mapItemType(ep.product.category);
    const hasVariants = ep.skus.length > 1;
    const parentSku = ep.product.skuPrefix;

    if (hasVariants) {
      const parentRow: Record<string, string> = {
        item_sku: parentSku, external_product_id: "", external_product_id_type: "",
        item_name: ep.product.name || parentSku, brand_name: "Jaxy", manufacturer: "Jaxy Eyewear",
        product_description: description,
        bullet_point1: bullets[0] || "", bullet_point2: bullets[1] || "", bullet_point3: bullets[2] || "",
        bullet_point4: bullets[3] || "", bullet_point5: bullets[4] || "",
        standard_price: "", quantity: "", main_image_url: "",
        other_image_url1: "", other_image_url2: "", other_image_url3: "", other_image_url4: "",
        color_name: "", color_map: "", size_name: "",
        frame_material_type: ep.product.frameMaterial || "", department_name: department,
        item_type_keyword: itemType, style_keyword: ep.product.frameShape || "",
        parent_child: "parent", parent_sku: "", relationship_type: "", variation_theme: "Color",
      };
      lines.push(AMAZON_HEADERS.map((h) => escTsv(parentRow[h] || "")).join("\t"));
    }

    for (const sku of ep.skus) {
      const skuImages = ep.images.filter((i) => i.skuId === sku.id && i.status === "approved" && i.filePath).sort((a, b) => (b.isBest ? 1 : 0) - (a.isBest ? 1 : 0)).map((i) => i.filePath || "");
      const row: Record<string, string> = {
        item_sku: sku.sku || "", external_product_id: sku.upc || "",
        external_product_id_type: sku.upc ? "UPC" : "", item_name: ep.product.name || parentSku,
        brand_name: "Jaxy", manufacturer: "Jaxy Eyewear", product_description: description,
        bullet_point1: bullets[0] || "", bullet_point2: bullets[1] || "", bullet_point3: bullets[2] || "",
        bullet_point4: bullets[3] || "", bullet_point5: bullets[4] || "",
        standard_price: price, quantity: sku.inStock ? "100" : "0",
        main_image_url: skuImages[0] || "", other_image_url1: skuImages[1] || "",
        other_image_url2: skuImages[2] || "", other_image_url3: skuImages[3] || "",
        other_image_url4: skuImages[4] || "",
        color_name: sku.colorName || "", color_map: mapColorMap(sku.colorName), size_name: sku.size || "",
        frame_material_type: ep.product.frameMaterial || "", department_name: department,
        item_type_keyword: itemType, style_keyword: ep.product.frameShape || "",
        parent_child: hasVariants ? "child" : "", parent_sku: hasVariants ? parentSku : "",
        relationship_type: hasVariants ? "Variation" : "", variation_theme: hasVariants ? "Color" : "",
      };
      lines.push(AMAZON_HEADERS.map((h) => escTsv(row[h] || "")).join("\t"));
    }
  }

  return lines.join("\n");
}
