/**
 * Faire delivery for product videos.
 *
 * IMPORTANT — why this isn't an API push like Shopify:
 * Faire's brand portal DOES support product videos (Products → the product
 * → Videos; up to 3 per product, ≤2GB, 1080p+ recommended), but Faire's
 * external API v2 only exposes IMAGE upload for products — there is no
 * documented endpoint for uploading a product VIDEO. Rather than invent
 * one that would 404, this prepares the exact file Faire wants and records
 * that it was handed off, so the last step is a drag-and-drop in the
 * portal and the team can still see what's been done.
 *
 * If Faire ships a video endpoint (or we get partner access to one), the
 * upload slots straight in here behind the same approve gate.
 */
import { sqlite } from "@/lib/db";
import { videoUrl } from "@/lib/storage/videos";

/** Faire's stated limits for product videos. */
export const FAIRE_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
export const FAIRE_MAX_VIDEOS_PER_PRODUCT = 3;
export const FAIRE_MIN_HEIGHT = 1080;

export interface FaireExport {
  ok: boolean;
  productId: string;
  productName?: string;
  /** Direct download of the master to upload in the Faire portal. */
  downloadUrl?: string;
  fileName?: string;
  caption?: string | null;
  /** Anything about the file Faire would reject or warn about. */
  warnings?: string[];
  error?: string;
}

/**
 * Prepare an approved product video for Faire and stamp it as exported.
 * Same approve gate as Shopify — nothing leaves the Frame unreviewed.
 */
export function exportProductVideoForFaire(productId: string): FaireExport {
  const row = sqlite
    .prepare(
      `SELECT pv.file_path AS filePath, pv.status, pv.approved_at AS approvedAt,
              pv.size_bytes AS sizeBytes, pv.caption, pv.updated_at AS updatedAt,
              p.name AS productName
         FROM marketing_product_videos pv
         JOIN catalog_products p ON p.id = pv.product_id
        WHERE pv.product_id = ?`,
    )
    .get(productId) as
    | {
        filePath: string | null;
        status: string;
        approvedAt: string | null;
        sizeBytes: number | null;
        caption: string | null;
        updatedAt: string | null;
        productName: string;
      }
    | undefined;

  if (!row) return { ok: false, productId, error: "No product video built yet" };
  if (row.status !== "ready" || !row.filePath) return { ok: false, productId, error: "Video isn't rendered" };
  if (!row.approvedAt) return { ok: false, productId, error: "Not approved — approve it before exporting" };

  const warnings: string[] = [];
  if ((row.sizeBytes ?? 0) > FAIRE_MAX_BYTES) {
    warnings.push(`Over Faire's 2 GB limit (${((row.sizeBytes ?? 0) / 1e9).toFixed(2)} GB)`);
  }

  sqlite
    .prepare(
      `UPDATE marketing_product_videos
          SET faire_exported_at = datetime('now'), updated_at = datetime('now')
        WHERE product_id = ?`,
    )
    .run(productId);

  const v = String(row.updatedAt ?? "").replace(/\D/g, "");
  return {
    ok: true,
    productId,
    productName: row.productName,
    // Cache-busted: the render path is deterministic and gets overwritten.
    downloadUrl: `${videoUrl(row.filePath)}${v ? `?v=${v}` : ""}`,
    fileName: `${slugify(row.productName)}-faire.mp4`,
    caption: row.caption,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "product";
}
