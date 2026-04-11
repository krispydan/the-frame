/**
 * Image Editor storage helpers.
 *
 * High-level functions that compute checksums, determine file paths,
 * write buffers to disk via the local storage abstraction, and return
 * metadata suitable for inserting into the pipeline/variation tables.
 */
import { createHash } from "crypto";
import sharp from "sharp";
import {
  saveImage,
  getStagePath,
  getVariationPath,
  getCollectionPath,
} from "@/lib/storage/local";

// ── Types ──

export interface ArtifactMetadata {
  filePath: string;
  fileSize: number;
  width: number;
  height: number;
  checksum: string;
}

// ── Helpers ──

function computeChecksum(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}

async function getImageDimensions(buffer: Buffer): Promise<{ width: number; height: number }> {
  const metadata = await sharp(buffer).metadata();
  return { width: metadata.width ?? 0, height: metadata.height ?? 0 };
}

function extFromBuffer(buffer: Buffer): string {
  // Check for PNG magic bytes
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "png";
  }
  // Check for JPEG magic bytes
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return "jpg";
  }
  // Default to png for RGBA pipeline output
  return "png";
}

// ── Public API ──

/**
 * Save a pipeline stage artifact to disk.
 *
 * Computes checksum, resolves the path via `getStagePath`, writes
 * the buffer, and returns metadata for the `catalog_image_pipelines` row.
 */
export async function saveStageArtifact(
  skuId: string,
  stage: string,
  buffer: Buffer,
): Promise<ArtifactMetadata> {
  const checksum = computeChecksum(buffer);
  const ext = extFromBuffer(buffer);
  const filePath = getStagePath(skuId, stage, checksum, ext);

  await saveImage(buffer, filePath);

  const { width, height } = await getImageDimensions(buffer);

  return {
    filePath,
    fileSize: buffer.length,
    width,
    height,
    checksum,
  };
}

/**
 * Save a variation artifact to disk.
 *
 * Used when generating threshold/method test variations for A/B comparison.
 */
export async function saveVariation(
  skuId: string,
  buffer: Buffer,
  label: string,
): Promise<ArtifactMetadata> {
  const checksum = computeChecksum(buffer);
  const ext = extFromBuffer(buffer);
  const filePath = getVariationPath(skuId, checksum, label, ext);

  await saveImage(buffer, filePath);

  const { width, height } = await getImageDimensions(buffer);

  return {
    filePath,
    fileSize: buffer.length,
    width,
    height,
    checksum,
  };
}

/**
 * Save a collection (composite) image to disk.
 *
 * Collection images are stored under `collections/<productId>/`.
 */
export async function saveCollectionImage(
  productId: string,
  buffer: Buffer,
): Promise<ArtifactMetadata> {
  const checksum = computeChecksum(buffer);
  const ext = extFromBuffer(buffer);
  const filePath = getCollectionPath(productId, checksum, ext);

  await saveImage(buffer, filePath);

  const { width, height } = await getImageDimensions(buffer);

  return {
    filePath,
    fileSize: buffer.length,
    width,
    height,
    checksum,
  };
}
