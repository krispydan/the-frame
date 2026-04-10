/**
 * Server-side image processing pipeline using sharp.
 *
 * Takes a raw upload buffer and produces a normalized JPEG:
 *   1. auto-orient from EXIF  (rotate)
 *   2. center-crop to 1:1 square and resize to 2000×2000  (cover)
 *   3. encode as JPEG @ q80 with mozjpeg
 *   4. strip metadata (no EXIF leaks)
 *
 * Returns the processed buffer plus derived metadata for the DB row.
 */
import sharp from "sharp";
import { createHash } from "crypto";

export const OUTPUT_SIZE = 2000;
export const OUTPUT_QUALITY = 80;
export const OUTPUT_MIME = "image/jpeg";
export const OUTPUT_EXT = "jpg";

export interface ProcessedImage {
  buffer: Buffer;
  width: number;
  height: number;
  size: number;
  mimeType: string;
  checksum: string; // sha256 hex of the output buffer
}

/**
 * Run a raw upload buffer through the normalization pipeline.
 * Throws if sharp cannot decode the input.
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  const pipeline = sharp(input, { failOn: "error" })
    .rotate() // auto-orient from EXIF
    .resize({
      width: OUTPUT_SIZE,
      height: OUTPUT_SIZE,
      fit: "cover",
      position: "center",
      withoutEnlargement: false,
    })
    .jpeg({
      quality: OUTPUT_QUALITY,
      mozjpeg: true,
      chromaSubsampling: "4:2:0",
    });

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

  const checksum = createHash("sha256").update(data).digest("hex");

  return {
    buffer: data,
    width: info.width,
    height: info.height,
    size: data.length,
    mimeType: OUTPUT_MIME,
    checksum,
  };
}

/**
 * Quick header-only inspection (no full decode) for early validation.
 * Returns null if sharp can't read it.
 */
export async function inspectImage(
  input: Buffer,
): Promise<{ width: number; height: number; format: string } | null> {
  try {
    const meta = await sharp(input).metadata();
    if (!meta.width || !meta.height || !meta.format) return null;
    return { width: meta.width, height: meta.height, format: meta.format };
  } catch {
    return null;
  }
}
