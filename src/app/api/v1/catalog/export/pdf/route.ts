export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import PDFDocument from "pdfkit";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { loadExportProducts } from "@/modules/catalog/lib/export/load-products";
import type { ExportProduct } from "@/modules/catalog/lib/export/types";

function loadImageBuffer(imgUrl: string): Buffer | null {
  const candidates = [
    imgUrl,
    join(/* turbopackIgnore: true */ process.cwd(), imgUrl),
    join(/* turbopackIgnore: true */ process.cwd(), "data", imgUrl),
    join("/data/images", imgUrl),
  ];
  for (const fp of candidates) {
    if (existsSync(fp)) {
      return readFileSync(fp);
    }
  }
  return null;
}

// ── Design System ──

const GOLD = "#B8860B";
const DARK = "#1a1a1a";
const MED_GRAY = "#666666";
const LIGHT_GRAY = "#999999";
const BG_GRAY = "#F9F9F9";
const LINE_GRAY = "#E0E0E0";

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 43.2;
const CW = PAGE_W - 2 * MARGIN;

const IMG_RATIO = 509 / 1023; // ~0.497
const IMG_GAP = 6;
const PAGE_BOTTOM = PAGE_H - MARGIN - 20;

interface CatalogSettings {
  showPreorder: boolean;
  showOrderForm: boolean;
  showTerms: boolean;
  season: string;
  preorderDiscount: number;
}

interface PdfState {
  doc: PDFKit.PDFDocument;
  y: number;
  pageNum: number;
  expectedPages: number;
}

interface CatalogProduct {
  title: string;
  skuPrefix: string;
  lens: string;
  wholesale: number;
  retail: number;
  variants: { sku: string; color: string }[];
  imageUrls: string[]; // one URL per variant
}

// ── Helpers ──

function titleCase(s: string): string {
  return s.toLowerCase().split(/[\s/]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function centerText(doc: PDFKit.PDFDocument, text: string, y: number, opts: object = {}) {
  doc.text(text, MARGIN, y, { width: CW, align: "center", lineBreak: false, ...opts });
}

function drawLine(doc: PDFKit.PDFDocument, y: number) {
  doc.strokeColor(LINE_GRAY).lineWidth(0.5).moveTo(MARGIN, y).lineTo(PAGE_W - MARGIN, y).stroke();
}

function drawPageNumber(state: PdfState) {
  if (state.pageNum > 1) {
    state.doc.font("Helvetica").fontSize(8).fillColor(LIGHT_GRAY);
    state.doc.text(String(state.pageNum), MARGIN, PAGE_H - 30, { width: CW, align: "center", lineBreak: false });
  }
}

function newPage(state: PdfState) {
  // When text overflows, pdfkit auto-adds a page. Detect and reuse it
  // instead of calling addPage() again (which would create a blank page).
  const range = state.doc.bufferedPageRange();
  const actualPages = range.start + range.count;
  if (actualPages > state.expectedPages) {
    state.doc.switchToPage(actualPages - 1);
    state.expectedPages = actualPages;
  } else {
    state.doc.addPage();
    state.expectedPages++;
  }
  state.pageNum++;
}

// ── Transform export products to catalog format ──

function toCatalogProducts(exportProducts: ExportProduct[]): CatalogProduct[] {
  return exportProducts
    .filter(ep => ep.skus.length > 0)
    .map(ep => {
      // Pick one image URL per variant (prefer approved, isBest)
      const skuImageMap = new Map<string, string>();
      for (const img of ep.images) {
        if (!img.filePath) continue;
        const existing = skuImageMap.get(img.skuId);
        if (!existing || img.isBest || img.status === "approved") {
          skuImageMap.set(img.skuId, img.filePath);
        }
      }

      return {
        title: ep.product.name || ep.product.skuPrefix || "Untitled",
        skuPrefix: ep.product.skuPrefix,
        lens: ep.product.frameShape === "polarized" || ep.product.name?.toLowerCase().includes("polarized") ? "Polarized" : "UV400",
        wholesale: ep.wholesalePrice || 7,
        retail: ep.retailPrice || 24,
        variants: ep.skus.map(s => ({
          sku: s.sku || "",
          color: titleCase(s.colorName || "Default"),
        })),
        imageUrls: ep.skus.map(s => skuImageMap.get(s.id) || ""),
      };
    })
    .sort((a, b) => (a.variants[0]?.sku || "").localeCompare(b.variants[0]?.sku || ""));
}

// ── Cover Page ──

function drawCover(state: PdfState, settings: CatalogSettings) {
  newPage(state);
  state.doc.rect(0, 0, PAGE_W, PAGE_H).fill("white");

  state.doc.font("Helvetica-Bold").fontSize(36).fillColor(DARK);
  centerText(state.doc, "JAXY", PAGE_H / 2 - 80);

  // Small divider line
  const lineW = 60;
  state.doc.strokeColor(GOLD).lineWidth(2)
    .moveTo((PAGE_W - lineW) / 2, PAGE_H / 2 - 35)
    .lineTo((PAGE_W + lineW) / 2, PAGE_H / 2 - 35).stroke();

  // Season + collection
  state.doc.font("Helvetica").fontSize(14).fillColor(DARK);
  const spacedSeason = settings.season.toUpperCase().split("").join(" ");
  centerText(state.doc, `${spacedSeason}   C O L L E C T I O N`, PAGE_H / 2 - 10);

  state.doc.fontSize(10).fillColor(MED_GRAY);
  centerText(state.doc, "W H O L E S A L E   C A T A L O G", PAGE_H / 2 + 20);

  // Footer tagline
  state.doc.fontSize(9).fillColor(LIGHT_GRAY);
  centerText(state.doc, "Born in Los Angeles  ·  Independent Eyewear", PAGE_H - 65);
}

// ── Product Pages ──

function drawProductPages(state: PdfState, products: CatalogProduct[], settings: CatalogSettings) {
  function productHeight(p: CatalogProduct): number {
    const n = p.variants.length;
    const imgW = Math.min(120, (CW - IMG_GAP * (n - 1)) / n);
    const imgH = imgW * IMG_RATIO;
    return 18 + imgH + 12 + 10 + 10;
  }

  function startProductPage() {
    newPage(state);
    state.doc.rect(0, 0, PAGE_W, PAGE_H).fill("white");
    state.doc.font("Helvetica").fontSize(8).fillColor(LIGHT_GRAY);
    state.doc.text(`JAXY  ·  ${settings.season.toUpperCase()}`, MARGIN, MARGIN, { width: CW, lineBreak: false });
    state.y = MARGIN + 16;
  }

  startProductPage();

  for (const prod of products) {
    const h = productHeight(prod);
    if (state.y + h > PAGE_BOTTOM) {
      drawPageNumber(state);
      startProductPage();
    }

    // Title
    state.doc.font("Helvetica-Bold").fontSize(11).fillColor(DARK);
    const titleText = prod.title;
    const titleW = state.doc.widthOfString(titleText);
    state.doc.text(titleText, MARGIN, state.y, { lineBreak: false });

    // Price after title
    state.doc.font("Helvetica").fontSize(8.5).fillColor(MED_GRAY);
    const priceText = `—  $${prod.wholesale.toFixed(2)} wholesale`;
    const priceX = MARGIN + titleW + 6;
    state.doc.text(priceText, priceX, state.y + 2, { lineBreak: false });
    const priceW = state.doc.widthOfString(priceText);

    // Lens badge (rounded pill)
    const badgeText = prod.lens;
    state.doc.font("Helvetica-Bold").fontSize(6.5);
    const badgeW = state.doc.widthOfString(badgeText) + 8;
    const badgeX = priceX + priceW + 6;
    if (badgeX + badgeW < PAGE_W - MARGIN) {
      const badgeColor = prod.lens === "Polarized" ? GOLD : MED_GRAY;
      state.doc.roundedRect(badgeX, state.y + 1, badgeW, 11, 2).fill(badgeColor);
      state.doc.font("Helvetica-Bold").fontSize(6.5).fillColor("white");
      state.doc.text(badgeText, badgeX + 4, state.y + 3, { lineBreak: false });
    }

    state.y += 16;

    // Variant image placeholders in a row
    const numColors = prod.variants.length;
    const imgW = Math.min(120, (CW - IMG_GAP * (numColors - 1)) / numColors);
    const imgH = imgW * IMG_RATIO;

    for (let i = 0; i < prod.variants.length; i++) {
      const imgX = MARGIN + i * (imgW + IMG_GAP);
      // Grey background card for image placeholder
      state.doc.roundedRect(imgX, state.y, imgW, imgH, 3).fill(BG_GRAY);

      // Try to load image if it's a local file
      const imgUrl = prod.imageUrls[i];
      if (imgUrl) {
        try {
          const imgBuf = loadImageBuffer(imgUrl);
          if (imgBuf) {
            state.doc.image(imgBuf, imgX + 3, state.y + 3, {
              fit: [imgW - 6, imgH - 6],
              align: "center",
              valign: "center",
            });
          }
        } catch { /* image not available, show placeholder */ }
      }
    }

    // Color name + SKU labels under images
    const labelY = state.y + imgH + 3;
    for (let i = 0; i < prod.variants.length; i++) {
      const v = prod.variants[i];
      const imgX = MARGIN + i * (imgW + IMG_GAP);
      state.doc.font("Helvetica-Bold").fontSize(7).fillColor(DARK);
      state.doc.text(v.color, imgX, labelY, { width: imgW, align: "center", lineBreak: false });
      state.doc.font("Helvetica").fontSize(6).fillColor(LIGHT_GRAY);
      state.doc.text(v.sku, imgX, labelY + 9, { width: imgW, align: "center", lineBreak: false });
    }

    state.y = labelY + 22;
    drawLine(state.doc, state.y);
    state.y += 8;
  }
  drawPageNumber(state);
}

// ── Pre-Order Page ──

function drawPreorderPage(state: PdfState, avgWholesale: number, preorderPrice: number) {
  newPage(state);
  state.doc.rect(0, 0, PAGE_W, PAGE_H).fill("white");
  let y = PAGE_H / 2 - 150;

  // Gold accent bar
  state.doc.rect(MARGIN, y - 10, CW, 3).fill(GOLD);
  y += 10;

  state.doc.font("Helvetica-Bold").fontSize(28).fillColor(DARK);
  centerText(state.doc, "Pre-Order Special", y); y += 45;

  state.doc.font("Helvetica-Bold").fontSize(48).fillColor(GOLD);
  centerText(state.doc, "20% OFF", y); y += 55;

  state.doc.font("Helvetica").fontSize(13).fillColor(MED_GRAY);
  centerText(state.doc, "on all pre-orders placed before end of March", y); y += 50;

  // 3-column info cards
  const boxData = [
    ["PRE-ORDER PRICE", `$${preorderPrice.toFixed(2)} per unit`, `(Regular wholesale: $${avgWholesale.toFixed(2)})`],
    ["DELIVERY", "Early May 2026", "In time for summer selling season"],
    ["PROMOTIONAL MINIMUM", "3 units per SKU", "Part of the pre-order promotion"],
  ];
  const boxW = (CW - 28) / 3;
  for (let i = 0; i < boxData.length; i++) {
    const bx = MARGIN + i * (boxW + 14);
    state.doc.roundedRect(bx, y, boxW, 86, 6).lineWidth(0.5).fillAndStroke(BG_GRAY, LINE_GRAY);
    state.doc.font("Helvetica").fontSize(8).fillColor(LIGHT_GRAY);
    state.doc.text(boxData[i][0], bx, y + 12, { width: boxW, align: "center" });
    state.doc.font("Helvetica-Bold").fontSize(16).fillColor(DARK);
    state.doc.text(boxData[i][1], bx, y + 30, { width: boxW, align: "center" });
    state.doc.font("Helvetica").fontSize(8).fillColor(LIGHT_GRAY);
    state.doc.text(boxData[i][2], bx, y + 55, { width: boxW, align: "center" });
  }
  y += 120;

  state.doc.font("Helvetica").fontSize(10).fillColor(MED_GRAY);
  centerText(state.doc, "Contact us to place your pre-order today.", y); y += 18;
  centerText(state.doc, "orders@getjaxy.com  ·  getjaxy.com", y);
  drawPageNumber(state);
}

// ── Order Form Pages ──

function drawOrderFormPages(state: PdfState, products: CatalogProduct[], preorderPrice: number, avgWholesale: number) {
  const allSkus: { sku: string; style: string; color: string; wholesale: number }[] = [];
  for (const prod of products) {
    for (const v of prod.variants) {
      allSkus.push({ sku: v.sku, style: prod.title, color: v.color, wholesale: prod.wholesale });
    }
  }

  const ROWS_PER_PAGE = 38;
  for (let i = 0; i < allSkus.length; i += ROWS_PER_PAGE) {
    const chunk = allSkus.slice(i, i + ROWS_PER_PAGE);
    const title = i === 0 ? "Order Form" : "Order Form (continued)";
    newPage(state);
    state.doc.rect(0, 0, PAGE_W, PAGE_H).fill("white");
    state.y = MARGIN;
    state.doc.font("Helvetica-Bold").fontSize(16).fillColor(DARK);
    state.doc.text(title, MARGIN, state.y, { lineBreak: false }); state.y += 24;

    // Store info fields (first page only)
    if (i === 0) {
      state.doc.font("Helvetica").fontSize(9).fillColor(MED_GRAY);
      for (const line of [
        "Store Name: ________________________________________________    Date: ____________________",
        "Contact: ___________________________________________________    Phone: ___________________",
        "Email: _____________________________________________________",
      ]) { state.doc.text(line, MARGIN, state.y, { lineBreak: false }); state.y += 16; }
      state.y += 10;
    }

    // Table header
    const cols = [MARGIN, MARGIN + 85, MARGIN + 220, MARGIN + 300, MARGIN + 380, MARGIN + 460];
    const colLabels = ["SKU", "Style / Color", "Wholesale", "Qty (min 3)", "Line Total"];
    state.doc.rect(MARGIN, state.y - 2, CW, 14).fill(DARK);
    state.doc.font("Helvetica-Bold").fontSize(7).fillColor("white");
    for (let j = 0; j < colLabels.length; j++) {
      state.doc.text(colLabels[j], cols[j] + 3, state.y, { lineBreak: false });
    }
    state.y += 16;

    // Table rows
    for (let idx = 0; idx < chunk.length; idx++) {
      if (state.y > PAGE_H - MARGIN - 40) break;
      const s = chunk[idx];
      if (idx % 2 === 0) state.doc.rect(MARGIN, state.y - 2, CW, 13).fill(BG_GRAY);
      state.doc.font("Helvetica").fontSize(7.5).fillColor(DARK);
      state.doc.text(s.sku, cols[0] + 3, state.y, { lineBreak: false });
      state.doc.text(`${s.style} / ${s.color}`, cols[1] + 3, state.y, { lineBreak: false });
      state.doc.text(`$${s.wholesale.toFixed(2)}`, cols[2] + 3, state.y, { lineBreak: false });
      // Blank lines for qty and total
      state.doc.strokeColor(LINE_GRAY).lineWidth(0.3);
      for (const cx of [cols[3], cols[4]]) {
        state.doc.moveTo(cx + 3, state.y + 10).lineTo(cx + 65, state.y + 10).stroke();
      }
      state.y += 13;
    }

    state.y += 10;
    drawLine(state.doc, state.y);
    state.y += 14;

    // Pre-order callout
    state.doc.font("Helvetica-Bold").fontSize(8).fillColor(GOLD);
    state.doc.text(
      `PRE-ORDER: 20% off ($${preorderPrice.toFixed(2)}/unit)  ·  3 units per SKU minimum (promotional offer)  ·  $200 order minimum`,
      MARGIN, state.y, { lineBreak: false },
    );
    state.y += 12;
    state.doc.font("Helvetica").fontSize(7.5).fillColor(LIGHT_GRAY);
    state.doc.text(
      "Orders must be placed and paid before end of March to receive pre-order pricing. Estimated delivery: Early May 2026.",
      MARGIN, state.y, { lineBreak: false },
    );
    drawPageNumber(state);
  }
}

// ── Terms Page ──

function drawTermsPage(state: PdfState, avgWholesale: number, preorderPrice: number) {
  newPage(state);
  state.doc.rect(0, 0, PAGE_W, PAGE_H).fill("white");
  state.y = MARGIN;
  state.doc.font("Helvetica-Bold").fontSize(18).fillColor(DARK);
  state.doc.text("Terms & Policies", MARGIN, state.y); state.y += 22;
  drawLine(state.doc, state.y); state.y += 20;

  const sections: [string, string[]][] = [
    ["Payment Terms", [
      "Payment is required at time of placing your order.",
      "We accept Visa, Mastercard, American Express, and wire transfer.",
      "All prices are in USD.",
    ]],
    ["Pre-Order Terms", [
      "20% discount applies to all orders placed and paid before end of March 2026.",
      `Pre-order wholesale price: $${preorderPrice.toFixed(2)} per unit (regular $${avgWholesale.toFixed(2)}).`,
      "3 units per SKU minimum (promotional offer).",
      "Pre-orders are non-cancelable once confirmed.",
    ]],
    ["Order Minimums", [
      "Minimum order value: $200.",
      "Minimum 3 units per SKU (pre-order promotion).",
      "Mix and match colorways within each style.",
    ]],
    ["Shipping & Delivery", [
      "Estimated delivery: Early May 2026.",
      "Free shipping on US orders over $500 wholesale.",
      "Orders under $500: shipping will be billed at time of shipment.",
      "Standard shipping via UPS Ground (3-7 business days).",
      "Expedited shipping available at additional cost.",
      "We ship to all 50 US states. International inquiries welcome.",
    ]],
  ];

  for (const [sTitle, sLines] of sections) {
    state.doc.font("Helvetica-Bold").fontSize(11).fillColor(DARK);
    state.doc.text(sTitle, MARGIN + 7, state.y);
    state.y = (state.doc as unknown as { y: number }).y + 4;
    state.doc.font("Helvetica").fontSize(9).fillColor(MED_GRAY);
    for (const line of sLines) {
      state.doc.text(line, MARGIN + 14, state.y);
      state.y = (state.doc as unknown as { y: number }).y + 2;
    }
    state.y += 8;
  }
  drawPageNumber(state);
}

// ── Main Generator ──

function generateCatalogPDF(
  products: CatalogProduct[],
  settings: CatalogSettings,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const avgWholesale = products.length > 0
      ? products.reduce((s, p) => s + p.wholesale, 0) / products.length
      : 7;
    const preorderPrice = avgWholesale * (1 - settings.preorderDiscount);

    const doc = new PDFDocument({
      size: "letter",
      margin: MARGIN,
      autoFirstPage: false,
      bufferPages: true,
      info: {
        Title: `Jaxy — ${settings.season} Wholesale Collection`,
        Author: "Jaxy Eyewear",
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const state: PdfState = { doc, y: 0, pageNum: 0, expectedPages: 0 };

    drawCover(state, settings);
    drawProductPages(state, products, settings);
    if (settings.showPreorder) drawPreorderPage(state, avgWholesale, preorderPrice);
    if (settings.showOrderForm) drawOrderFormPages(state, products, preorderPrice, avgWholesale);
    if (settings.showTerms) drawTermsPage(state, avgWholesale, preorderPrice);

    doc.end();
  });
}

// ── Route Handlers ──

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const settings: CatalogSettings = {
      showPreorder: searchParams.get("preorder") !== "false",
      showOrderForm: searchParams.get("orderForm") !== "false",
      showTerms: searchParams.get("terms") !== "false",
      season: searchParams.get("season") || "Spring 2026",
      preorderDiscount: parseFloat(searchParams.get("preorderDiscount") || "0.2"),
    };

    const idsParam = searchParams.get("ids");
    const productIds = idsParam ? idsParam.split(",").filter(Boolean) : undefined;
    const exportProducts = await loadExportProducts(productIds);
    const catalogProducts = toCatalogProducts(exportProducts);

    const pdfBuffer = await generateCatalogPDF(catalogProducts, settings);
    const safeSeason = settings.season.toLowerCase().replace(/\s+/g, "-");

    return new NextResponse(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="jaxy-${safeSeason}-wholesale-catalog.pdf"`,
        "Content-Length": String(pdfBuffer.length),
      },
    });
  } catch (error) {
    console.error("Catalog PDF generation error:", error);
    return NextResponse.json(
      { error: "Failed to generate catalog PDF", details: String(error) },
      { status: 500 },
    );
  }
}
