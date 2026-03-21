/**
 * Shopify CSV Export — ported from ~/jaxy-catalog-tool/src/lib/export/shopify.ts
 */
import type { ExportProduct, ValidationIssue, ProductValidationResult } from "./types";
import Papa from "papaparse";

const SHAPE_TAGS = new Set(["aviator", "cat-eye", "round", "square", "oversized", "rectangle", "wayfarer", "oval", "geometric"]);
const STYLE_TAGS = new Set(["retro", "vintage", "classic", "modern", "bold", "statement", "timeless", "trendy"]);

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

export function generateShopifyCSV(exportProducts: ExportProduct[], channel: ShopifyChannel = "retail"): string {
  const rows: Record<string, string>[] = [];

  for (const ep of exportProducts) {
    const handle = slugify(ep.product.name || ep.product.skuPrefix || ep.product.id);
    const tagString = ep.tags.map((t) => t.tagName).filter(Boolean).join(", ");
    const allImages = ep.images.filter((i) => i.status === "approved").sort((a, b) => (b.isBest ? 1 : 0) - (a.isBest ? 1 : 0));
    const tagNames = ep.tags.map((t) => t.tagName).filter(Boolean) as string[];

    const variantPrice = channel === "wholesale"
      ? ((ep.wholesalePrice && ep.wholesalePrice > 0) ? ep.wholesalePrice.toFixed(2) : "8.00")
      : ((ep.retailPrice && ep.retailPrice > 0) ? ep.retailPrice.toFixed(2) : "24.00");
    const compareAtPrice = channel === "wholesale"
      ? ((ep.retailPrice && ep.retailPrice > 0) ? ep.retailPrice.toFixed(2) : "")
      : ((ep.msrp && ep.msrp > 0) ? ep.msrp.toFixed(2) : "");

    const firstSku = ep.skus[0];
    const firstImage = allImages[0];

    rows.push({
      Handle: handle, Title: ep.product.name || "", "Body (HTML)": ep.product.description || "",
      Vendor: "Jaxy", Type: ep.product.category || "", Tags: tagString, Published: "TRUE",
      "Option1 Name": ep.skus.length > 1 ? "Color" : "Title",
      "Option1 Value": firstSku?.colorName || "Default Title",
      "Variant SKU": firstSku?.sku || "", "Variant Price": variantPrice,
      "Variant Compare At Price": compareAtPrice,
      "Image Src": firstImage?.filePath || "", "Image Position": firstImage ? "1" : "",
      "Image Alt Text": firstImage ? buildSeoAltText(ep.product.name || "", firstSku?.colorName || null, tagNames, 0, allImages.length) : "",
      "SEO Title": ep.product.name || "", "SEO Description": ep.product.shortDescription || "",
    });

    for (let i = 1; i < ep.skus.length; i++) {
      rows.push({
        Handle: handle, Title: "", "Body (HTML)": "", Vendor: "", Type: "", Tags: "", Published: "",
        "Option1 Name": "", "Option1 Value": ep.skus[i].colorName || "",
        "Variant SKU": ep.skus[i].sku || "", "Variant Price": variantPrice,
        "Variant Compare At Price": compareAtPrice,
        "Image Src": "", "Image Position": "", "Image Alt Text": "", "SEO Title": "", "SEO Description": "",
      });
    }

    for (let i = 1; i < allImages.length; i++) {
      rows.push({
        Handle: handle, Title: "", "Body (HTML)": "", Vendor: "", Type: "", Tags: "", Published: "",
        "Option1 Name": "", "Option1 Value": "", "Variant SKU": "", "Variant Price": "",
        "Variant Compare At Price": "",
        "Image Src": allImages[i].filePath || "", "Image Position": String(i + 1),
        "Image Alt Text": buildSeoAltText(ep.product.name || "", null, tagNames, i, allImages.length),
        "SEO Title": "", "SEO Description": "",
      });
    }
  }

  return Papa.unparse(rows, { header: true });
}
