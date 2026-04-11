/**
 * Auto-crop: trim transparent pixels from an RGBA image to its
 * content bounding box, with optional padding.
 */
import sharp from "sharp";
import { findAlphaBoundingBox } from "../utils/alpha-ops";

/** Options for auto-cropping. */
export interface AutoCropOptions {
  /**
   * Extra padding (in pixels) to add around the content bounding box.
   * The padding area will be transparent. Default: 0.
   */
  padding?: number;
  /**
   * Minimum alpha value to consider a pixel as "content".
   * Default: 1 (any non-zero alpha).
   */
  alphaThreshold?: number;
}

/** Result of an auto-crop operation. */
export interface AutoCropResult {
  /** Cropped PNG buffer. */
  buffer: Buffer;
  /** Width of the cropped image. */
  width: number;
  /** Height of the cropped image. */
  height: number;
  /** Bounding box that was extracted from the original. */
  boundingBox: { left: number; top: number; width: number; height: number };
}

/**
 * Crop an RGBA PNG to its content bounding box (trimming transparent
 * pixels from all edges).
 *
 * @param buffer - RGBA PNG buffer with transparent background.
 * @param options - Padding and alpha threshold settings.
 * @returns Cropped image buffer with metadata.
 * @throws If the image is fully transparent (no content to crop to).
 */
export async function autoCrop(
  buffer: Buffer,
  options: AutoCropOptions = {},
): Promise<AutoCropResult> {
  const { padding = 0, alphaThreshold = 1 } = options;

  const bbox = await findAlphaBoundingBox(buffer, alphaThreshold);
  if (!bbox) {
    throw new Error(
      "Cannot auto-crop: image is fully transparent (no visible content).",
    );
  }

  const meta = await sharp(buffer).metadata();
  const imgWidth = meta.width!;
  const imgHeight = meta.height!;

  // Expand bounding box by padding, clamped to image bounds
  const left = Math.max(0, bbox.left - padding);
  const top = Math.max(0, bbox.top - padding);
  const right = Math.min(imgWidth, bbox.left + bbox.width + padding);
  const bottom = Math.min(imgHeight, bbox.top + bbox.height + padding);
  const cropWidth = right - left;
  const cropHeight = bottom - top;

  const cropped = await sharp(buffer)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .png()
    .toBuffer();

  const croppedMeta = await sharp(cropped).metadata();

  return {
    buffer: cropped,
    width: croppedMeta.width!,
    height: croppedMeta.height!,
    boundingBox: { left, top, width: cropWidth, height: cropHeight },
  };
}
