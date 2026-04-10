/**
 * Shared image precheck for export routes.
 *
 * Any selected product with zero approved images is a blocker — the
 * exported CSV would contain rows with no image URLs and Faire/Shopify
 * would reject them (or worse, accept them and embarrass us).
 */
import type { ExportProduct } from "./types";

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
