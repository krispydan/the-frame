export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { exports_ } from "@/modules/catalog/schema";
import { loadExportProducts } from "@/modules/catalog/lib/export/load-products";
import { generateShopifyCSV, validateProductsForShopify } from "@/modules/catalog/lib/export/shopify";
import { generateFaireCsv, generateFaireXlsx, validateForFaire } from "@/modules/catalog/lib/export/faire";
import { generateAmazonTsv, validateForAmazon } from "@/modules/catalog/lib/export/amazon";
import { findProductsMissingApprovedImages, findProductsWithMissingImageFiles } from "@/modules/catalog/lib/export/image-precheck";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
) {
  const { platform } = await params;
  const { searchParams } = request.nextUrl;
  const idsParam = searchParams.get("ids");
  const validateOnly = searchParams.get("validate") === "true";
  const channel = (searchParams.get("channel") as "retail" | "wholesale") || "retail";

  const productIds = idsParam ? idsParam.split(",").filter(Boolean) : undefined;
  const force = searchParams.get("force") === "true";
  const exportProducts = await loadExportProducts(productIds);

  const imageBlockers = findProductsMissingApprovedImages(exportProducts);

  if (validateOnly) {
    let validations;
    switch (platform) {
      case "shopify": validations = validateProductsForShopify(exportProducts, channel); break;
      case "faire": validations = exportProducts.map(validateForFaire); break;
      case "amazon": validations = exportProducts.map(validateForAmazon); break;
      default: return NextResponse.json({ error: "Invalid platform" }, { status: 400 });
    }

    // Cross-check: every approved image's file must exist on disk, or the
    // platform's fetcher will 404 on upload. Fold any missing files into
    // the per-product validations as blocked issues.
    const missingFiles = await findProductsWithMissingImageFiles(exportProducts);
    if (missingFiles.length > 0) {
      const byId = new Map(missingFiles.map((m) => [m.productId, m] as const));
      for (const v of validations) {
        const mf = byId.get(v.productId);
        if (!mf) continue;
        const bySource = new Map<string, number>();
        for (const f of mf.missing) {
          const k = f.source ?? "unknown";
          bySource.set(k, (bySource.get(k) ?? 0) + 1);
        }
        const breakdown = Array.from(bySource.entries()).map(([s, n]) => `${n} ${s}`).join(", ");
        v.issues.push({
          field: "images",
          message: `${mf.missing.length} image file${mf.missing.length === 1 ? "" : "s"} missing on disk (${breakdown}) — will 404 on upload`,
          severity: "blocked",
        });
        v.status = "blocked";
      }
    }

    return NextResponse.json({ validations, platform, imageBlockers, missingFiles });
  }

  if (imageBlockers.length > 0 && !force) {
    return NextResponse.json(
      {
        error: "Image precheck failed",
        message: `${imageBlockers.length} product${imageBlockers.length === 1 ? "" : "s"} have no approved images. Approve images in the Image Management tab, or retry with ?force=true to export anyway.`,
        imageBlockers,
      },
      { status: 422 },
    );
  }

  // Save export record
  const exportId = crypto.randomUUID();
  const datestamp = new Date().toISOString().split("T")[0];

  switch (platform) {
    case "shopify": {
      const csv = generateShopifyCSV(exportProducts, channel);
      await db.insert(exports_).values({
        id: exportId, platform: platform as any,
        filePath: `exports/shopify_${Date.now()}.csv`,
        productCount: exportProducts.length, createdBy: "admin",
      });
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="jaxy_shopify_${datestamp}.csv"`,
        },
      });
    }
    case "faire": {
      // Faire only accepts XLSX uploads — generate Excel workbook
      const xlsxBuf = generateFaireXlsx(exportProducts);
      await db.insert(exports_).values({
        id: exportId, platform: platform as any,
        filePath: `exports/faire_${Date.now()}.xlsx`,
        productCount: exportProducts.length, createdBy: "admin",
      });
      return new NextResponse(new Uint8Array(xlsxBuf), {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="jaxy_faire_${datestamp}.xlsx"`,
        },
      });
    }
    case "amazon": {
      const tsv = generateAmazonTsv(exportProducts);
      await db.insert(exports_).values({
        id: exportId, platform: platform as any,
        filePath: `exports/amazon_${Date.now()}.tsv`,
        productCount: exportProducts.length, createdBy: "admin",
      });
      return new NextResponse(tsv, {
        headers: {
          "Content-Type": "text/tab-separated-values",
          "Content-Disposition": `attachment; filename="jaxy_amazon_${datestamp}.tsv"`,
        },
      });
    }
    default:
      return NextResponse.json({ error: "Invalid platform. Use: shopify, faire, amazon" }, { status: 400 });
  }
}
