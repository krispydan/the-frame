export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { exports_ } from "@/modules/catalog/schema";
import { loadExportProducts } from "@/modules/catalog/lib/export/load-products";
import { generateShopifyCSV, validateProductsForShopify, buildShopifyImageList } from "@/modules/catalog/lib/export/shopify";
import { generateFaireCsv, generateFaireXlsx, validateForFaire } from "@/modules/catalog/lib/export/faire";
import { generateAmazonTsv, validateForAmazon } from "@/modules/catalog/lib/export/amazon";
import type { ExportStatus } from "@/modules/catalog/lib/export/types";
import {
  findProductsMissingApprovedImages,
  findProductsWithMissingImageFiles,
  findProductsWithMissingImageFilesByList,
} from "@/modules/catalog/lib/export/image-precheck";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
) {
  const { platform } = await params;
  const { searchParams } = request.nextUrl;
  const idsParam = searchParams.get("ids");
  const validateOnly = searchParams.get("validate") === "true";
  const channel = (searchParams.get("channel") as "retail" | "wholesale") || "retail";

  const force = searchParams.get("force") === "true";

  // Channel listing status. Drafts are the default so a new batch can be
  // reviewed on the platform before it goes live.
  const status: ExportStatus = searchParams.get("status") === "active" ? "active" : "draft";

  // Optional "only products added in this window" filter, so a batch of
  // newly-intaken products can be exported without re-sending the whole
  // catalog. Dates are inclusive, YYYY-MM-DD, against catalog_products.created_at.
  const createdAfter = searchParams.get("createdAfter");
  const createdBefore = searchParams.get("createdBefore");

  let productIds = idsParam ? idsParam.split(",").filter(Boolean) : undefined;
  if (createdAfter || createdBefore) {
    const clauses: string[] = [];
    const params: string[] = [];
    if (createdAfter) { clauses.push("date(created_at) >= date(?)"); params.push(createdAfter); }
    if (createdBefore) { clauses.push("date(created_at) <= date(?)"); params.push(createdBefore); }
    const rows = sqlite
      .prepare(`SELECT id FROM catalog_products WHERE ${clauses.join(" AND ")}`)
      .all(...params) as Array<{ id: string }>;
    const inWindow = new Set(rows.map((r) => r.id));
    productIds = productIds ? productIds.filter((id) => inWindow.has(id)) : [...inWindow];
    if (productIds.length === 0) {
      return NextResponse.json(
        { error: "No products in that date range", createdAfter, createdBefore },
        { status: 404 },
      );
    }
  }

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
    // the per-product validations as warnings — they don't block the
    // export, but the operator should know before uploading.
    //
    // Shopify validates against the exact list the exporter will emit
    // (front per SKU + main SKU angles + lifestyle + collection), so we
    // don't false-positive on approved squares that the CSV never
    // references. Faire and Amazon still use the source-filter variant.
    let missingFiles: Awaited<ReturnType<typeof findProductsWithMissingImageFiles>> = [];
    if (platform === "shopify") {
      missingFiles = await findProductsWithMissingImageFilesByList(exportProducts, (ep) => {
        const { productImages } = buildShopifyImageList(ep, channel);
        return productImages.map((i) => ({ filePath: i.filePath, source: i.source }));
      });
    } else {
      const platformSources: Record<string, string[] | undefined> = {
        faire: ["square", "collection"],
        amazon: undefined, // amazon still emits all per-SKU images
      };
      missingFiles = await findProductsWithMissingImageFiles(exportProducts, platformSources[platform]);
    }
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
          severity: "warning",
        });
        if (v.status === "ready") v.status = "warning";
      }
    }

    return NextResponse.json({ validations, platform, imageBlockers, missingFiles });
  }

  // Missing images are a WARNING, not a blocker. A product with no
  // approved image still exports (its image columns come out empty) —
  // operators routinely need the sheet before photography is finished,
  // and the validate view already lists exactly which products are
  // short. The count rides back on a response header so the caller can
  // surface it next to the download.
  const imageWarningHeaders: Record<string, string> = imageBlockers.length
    ? {
        "X-Image-Warning-Count": String(imageBlockers.length),
        "X-Image-Warning": `${imageBlockers.length} product${imageBlockers.length === 1 ? "" : "s"} exported without approved images`,
      }
    : {};

  // Save export record
  const exportId = crypto.randomUUID();
  const datestamp = new Date().toISOString().split("T")[0];

  switch (platform) {
    case "shopify": {
      const csv = generateShopifyCSV(exportProducts, channel, status);
      await db.insert(exports_).values({
        id: exportId, platform: platform as any,
        filePath: `exports/shopify_${Date.now()}.csv`,
        productCount: exportProducts.length, createdBy: "admin",
      });
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="jaxy_shopify_${datestamp}.csv"`,
          ...imageWarningHeaders,
        },
      });
    }
    case "faire": {
      // Faire only accepts XLSX uploads — generate Excel workbook
      const xlsxBuf = generateFaireXlsx(exportProducts, status);
      await db.insert(exports_).values({
        id: exportId, platform: platform as any,
        filePath: `exports/faire_${Date.now()}.xlsx`,
        productCount: exportProducts.length, createdBy: "admin",
      });
      return new NextResponse(new Uint8Array(xlsxBuf), {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="jaxy_faire_${datestamp}.xlsx"`,
          ...imageWarningHeaders,
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
          ...imageWarningHeaders,
        },
      });
    }
    default:
      return NextResponse.json({ error: "Invalid platform. Use: shopify, faire, amazon" }, { status: 400 });
  }
}
