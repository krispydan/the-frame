import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { exports_ } from "@/modules/catalog/schema";
import { loadExportProducts } from "@/modules/catalog/lib/export/load-products";
import { generateShopifyCSV, validateProductsForShopify } from "@/modules/catalog/lib/export/shopify";
import { generateFaireCsv, validateForFaire } from "@/modules/catalog/lib/export/faire";
import { generateAmazonTsv, validateForAmazon } from "@/modules/catalog/lib/export/amazon";

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
  const exportProducts = await loadExportProducts(productIds);

  if (validateOnly) {
    let validations;
    switch (platform) {
      case "shopify": validations = validateProductsForShopify(exportProducts, channel); break;
      case "faire": validations = exportProducts.map(validateForFaire); break;
      case "amazon": validations = exportProducts.map(validateForAmazon); break;
      default: return NextResponse.json({ error: "Invalid platform" }, { status: 400 });
    }
    return NextResponse.json({ validations, platform });
  }

  let csv: string;
  let contentType: string;
  let ext: string;

  switch (platform) {
    case "shopify":
      csv = generateShopifyCSV(exportProducts, channel);
      contentType = "text/csv";
      ext = "csv";
      break;
    case "faire":
      csv = generateFaireCsv(exportProducts);
      contentType = "text/csv";
      ext = "csv";
      break;
    case "amazon":
      csv = generateAmazonTsv(exportProducts);
      contentType = "text/tab-separated-values";
      ext = "tsv";
      break;
    default:
      return NextResponse.json({ error: "Invalid platform. Use: shopify, faire, amazon" }, { status: 400 });
  }

  // Save export record
  const exportId = crypto.randomUUID();
  await db.insert(exports_).values({
    id: exportId,
    platform: platform as any,
    filePath: `exports/${platform}_${Date.now()}.${ext}`,
    productCount: exportProducts.length,
    createdBy: "admin",
  });

  return new NextResponse(csv, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="jaxy_${platform}_${new Date().toISOString().split("T")[0]}.${ext}"`,
    },
  });
}
