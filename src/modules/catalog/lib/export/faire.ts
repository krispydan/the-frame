/**
 * Faire CSV Export — ported from ~/jaxy-catalog-tool/src/lib/export/faire.ts
 */
import type { ExportProduct, ProductValidationResult, ValidationIssue } from "./types";

function worstSeverity(issues: ValidationIssue[]): "ready" | "blocked" | "warning" {
  if (issues.some((i) => i.severity === "blocked")) return "blocked";
  if (issues.some((i) => i.severity === "warning")) return "warning";
  return "ready";
}

export function validateForFaire(product: ExportProduct): ProductValidationResult {
  const issues: ValidationIssue[] = [];
  const title = product.product.name || "";
  if (!title) issues.push({ field: "name", message: "Product name is required", severity: "blocked" });
  else if (title.length > 60) issues.push({ field: "name", message: `Title exceeds 60 chars (${title.length})`, severity: "blocked" });
  if (!product.product.description) issues.push({ field: "description", message: "Description is missing", severity: "warning" });
  if (!product.wholesalePrice) issues.push({ field: "wholesalePrice", message: "Wholesale price required", severity: "blocked" });
  if (product.skus.length === 0) issues.push({ field: "skus", message: "No SKUs found", severity: "blocked" });
  const skusWithoutUpc = product.skus.filter((s) => !s.upc);
  if (skusWithoutUpc.length > 0) issues.push({ field: "upc", message: `${skusWithoutUpc.length} SKU(s) missing UPC`, severity: "blocked" });

  return {
    productId: product.product.id, productName: title || product.product.skuPrefix,
    skuPrefix: product.product.skuPrefix, status: worstSeverity(issues), issues, skuResults: [],
  };
}

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

function mapFaireCategory(category: string | null): string {
  switch (category) {
    case "sunglasses": return "Accessories > Sunglasses";
    case "optical": return "Accessories > Eyeglasses";
    case "reading": return "Accessories > Reading Glasses";
    default: return "Accessories > Sunglasses";
  }
}

const HEADERS = ["Brand", "Product Name", "Option 1 Name", "Option 1 Value", "Option 2 Name", "Option 2 Value", "Wholesale Price", "Retail Price", "UPC/EAN", "Description", "Category", "Image 1", "Image 2", "Image 3", "Image 4", "Image 5", "SKU", "Made In", "Ships From"];

export function generateFaireCsv(exportProducts: ExportProduct[]): string {
  const rows: string[] = [HEADERS.map(escapeCsvField).join(",")];

  for (const ep of exportProducts) {
    const description = ep.product.description ? stripHtml(ep.product.description) : "";
    const wholesale = (ep.wholesalePrice && ep.wholesalePrice > 0 ? ep.wholesalePrice : 8).toFixed(2);
    const retail = ((ep.retailPrice && ep.retailPrice > 0 ? ep.retailPrice : null) || (ep.msrp && ep.msrp > 0 ? ep.msrp : null) || 24).toFixed(2);
    const category = mapFaireCategory(ep.product.category);

    for (const sku of ep.skus) {
      const skuImages = ep.images.filter((i) => i.skuId === sku.id).sort((a, b) => (b.isBest ? 1 : 0) - (a.isBest ? 1 : 0)).map((i) => i.filePath || "");
      const values = [
        "Jaxy", ep.product.name || ep.product.skuPrefix, "Color", sku.colorName || "",
        sku.size ? "Size" : "", sku.size || "", wholesale, retail, sku.upc || "",
        description, category, skuImages[0] || "", skuImages[1] || "", skuImages[2] || "",
        skuImages[3] || "", skuImages[4] || "", sku.sku || "", "China", "United States",
      ];
      rows.push(values.map(escapeCsvField).join(","));
    }
  }

  return rows.join("\n");
}
