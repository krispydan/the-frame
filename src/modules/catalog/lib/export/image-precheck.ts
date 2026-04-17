/**
 * Shared image precheck for export routes.
 *
 * Any selected product with zero approved images is a blocker — the
 * exported CSV would contain rows with no image URLs and Faire/Shopify
 * would reject them (or worse, accept them and embarrass us).
 *
 * Also checks that every approved image's file actually exists on the
 * images volume (/data/images or $IMAGES_PATH). A DB row can point at
 * a file path that's been superseded on disk, which causes Faire to
 * 404 when it tries to download the URL.
 */
import type { ExportProduct } from "./types";
import { imageStat } from "@/lib/storage/local";

export interface ImageBlocker {
  productId: string;
  productName: string;
  reason: "no-approved-images" | "no-images-at-all";
  approvedCount: number;
  totalCount: number;
}

export function findProductsMissingApprovedImages(
  products: ExportProduct[],
): ImageBlocker[] {
  const blockers: ImageBlocker[] = [];
  for (const p of products) {
    const total = p.images.length;
    const approved = p.images.filter((i) => i.status === "approved").length;
    if (approved === 0) {
      blockers.push({
        productId: p.product.id,
        productName: p.product.name ?? p.product.skuPrefix ?? p.product.id,
        reason: total === 0 ? "no-images-at-all" : "no-approved-images",
        approvedCount: approved,
        totalCount: total,
      });
    }
  }
  return blockers;
}

export interface MissingImageFile {
  productId: string;
  productName: string;
  missing: { source: string | null; filePath: string }[];
}

/**
 * For each product, verify every approved image's filePath resolves to
 * a real file on disk. Returns products with at least one missing file.
 * Parallelised in batches of 50 to avoid thrashing the event loop.
 */
export async function findProductsWithMissingImageFiles(
  products: ExportProduct[],
): Promise<MissingImageFile[]> {
  const out: MissingImageFile[] = [];

  // Gather every approved image across all products and stat in batches.
  type Check = { productId: string; filePath: string; source: string | null };
  const checks: Check[] = [];
  for (const p of products) {
    for (const i of p.images) {
      if (i.status === "approved" && i.filePath) {
        // image source isn't on the ExportProduct image shape yet; fall back to null.
        checks.push({ productId: p.product.id, filePath: i.filePath, source: (i as { source?: string | null }).source ?? null });
      }
    }
  }

  const existsMap = new Map<string, boolean>();
  const batchSize = 50;
  for (let i = 0; i < checks.length; i += batchSize) {
    const batch = checks.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (c) => [c.filePath, (await imageStat(c.filePath)).exists] as const));
    for (const [fp, ok] of results) existsMap.set(fp, ok);
  }

  for (const p of products) {
    const missing: { source: string | null; filePath: string }[] = [];
    for (const i of p.images) {
      if (i.status === "approved" && i.filePath && existsMap.get(i.filePath) === false) {
        missing.push({ source: (i as { source?: string | null }).source ?? null, filePath: i.filePath });
      }
    }
    if (missing.length > 0) {
      out.push({
        productId: p.product.id,
        productName: p.product.name ?? p.product.skuPrefix ?? p.product.id,
        missing,
      });
    }
  }

  return out;
}
