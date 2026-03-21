export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { loadExportProducts } from "@/modules/catalog/lib/export/load-products";

/**
 * PDF Catalog / Line Sheet Generator
 * Generates a print-optimized HTML document with @media print styles.
 * Open in browser and Print → Save as PDF for a clean line sheet.
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const productIds = body.ids as string[] | undefined;

  const exportProducts = await loadExportProducts(productIds);

  const productRows = exportProducts
    .map((ep) => {
      const name = ep.product.name || ep.product.skuPrefix || "Untitled";
      const description = ep.product.description || "";
      const category = ep.product.category || "";
      const wholesale = ep.wholesalePrice
        ? `$${Number(ep.wholesalePrice).toFixed(2)}`
        : "—";
      const msrp = ep.msrp ? `$${Number(ep.msrp).toFixed(2)}` : "—";
      const retail = ep.retailPrice
        ? `$${Number(ep.retailPrice).toFixed(2)}`
        : "—";

      const skuRows = ep.skus
        .map(
          (s) => `
        <tr class="sku-row">
          <td>${s.sku || "—"}</td>
          <td>${s.colorName || "—"}</td>
          <td>${s.upc || "—"}</td>
        </tr>`
        )
        .join("");

      const images = ep.images
        .filter((i) => i.status === "approved" || i.isBest)
        .slice(0, 3);
      const imageHtml = images.length
        ? images
            .map(
              (i) =>
                `<img src="${i.filePath}" alt="${name}" style="max-width:120px;max-height:90px;object-fit:contain;border:1px solid #e5e7eb;border-radius:4px;" />`
            )
            .join(" ")
        : '<span style="color:#9ca3af;">No images</span>';

      return `
      <div class="product-card">
        <div class="product-header">
          <div class="product-info">
            <h2>${escapeHtml(name)}</h2>
            ${category ? `<span class="category">${escapeHtml(category)}</span>` : ""}
            ${description ? `<p class="description">${escapeHtml(description)}</p>` : ""}
          </div>
          <div class="product-images">${imageHtml}</div>
        </div>
        <div class="pricing">
          <div class="price-item"><label>Wholesale</label><span>${wholesale}</span></div>
          <div class="price-item"><label>MSRP</label><span>${msrp}</span></div>
          <div class="price-item"><label>Retail</label><span>${retail}</span></div>
        </div>
        ${
          ep.skus.length > 0
            ? `
        <table class="sku-table">
          <thead><tr><th>SKU</th><th>Color</th><th>UPC</th></tr></thead>
          <tbody>${skuRows}</tbody>
        </table>`
            : ""
        }
      </div>`;
    })
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Jaxy Eyewear — Wholesale Line Sheet</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1f2937; background: #fff; padding: 40px; }
  .header { text-align: center; margin-bottom: 40px; border-bottom: 2px solid #111827; padding-bottom: 20px; }
  .header h1 { font-size: 28px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; }
  .header p { font-size: 13px; color: #6b7280; margin-top: 4px; }
  .meta { text-align: center; font-size: 12px; color: #9ca3af; margin-bottom: 30px; }
  .product-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 20px; page-break-inside: avoid; }
  .product-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 12px; }
  .product-info { flex: 1; }
  .product-info h2 { font-size: 18px; font-weight: 600; }
  .product-info .category { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 1px; }
  .product-info .description { font-size: 13px; color: #4b5563; margin-top: 6px; line-height: 1.4; }
  .product-images { display: flex; gap: 8px; flex-shrink: 0; }
  .pricing { display: flex; gap: 24px; margin-bottom: 12px; padding: 10px 0; border-top: 1px solid #f3f4f6; border-bottom: 1px solid #f3f4f6; }
  .price-item label { font-size: 11px; text-transform: uppercase; color: #9ca3af; display: block; }
  .price-item span { font-size: 16px; font-weight: 600; }
  .sku-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .sku-table th { text-align: left; padding: 6px 12px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; font-weight: 600; font-size: 11px; text-transform: uppercase; color: #6b7280; }
  .sku-table td { padding: 6px 12px; border-bottom: 1px solid #f3f4f6; }
  .footer { text-align: center; margin-top: 40px; padding-top: 20px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #9ca3af; }
  @media print {
    body { padding: 20px; }
    .product-card { break-inside: avoid; }
    .no-print { display: none; }
  }
</style>
</head>
<body>
<div class="header">
  <h1>Jaxy Eyewear</h1>
  <p>Wholesale Line Sheet</p>
</div>
<div class="meta">${exportProducts.length} products &middot; Generated ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</div>
<p class="no-print" style="text-align:center;margin-bottom:20px;font-size:13px;color:#6b7280;">
  <button onclick="window.print()" style="padding:8px 20px;background:#111827;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;">Print / Save as PDF</button>
</p>
${productRows}
<div class="footer">Jaxy Eyewear &middot; getjaxy.com &middot; Confidential — For Authorized Retailers Only</div>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
