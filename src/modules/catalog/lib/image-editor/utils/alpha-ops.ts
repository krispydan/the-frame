/**
 * Alpha channel operations for RGBA image buffers.
 *
 * Works with raw pixel data (Uint8Array from Sharp's .raw() output)
 * as well as encoded PNG buffers.
 */
import sharp from "sharp";

/** Metadata returned alongside raw pixel data. */
export interface RawImageData {
  data: Buffer;
  width: number;
  height: number;
  channels: 4;
}

/**
 * Decode any image buffer into raw RGBA pixel data.
 *
 * @param buffer - Encoded image (PNG, JPEG, WebP, etc.).
 * @returns Raw RGBA pixels with dimensions.
 */
export async function toRawRGBA(buffer: Buffer): Promise<RawImageData> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { data, width: info.width, height: info.height, channels: 4 };
}

/**
 * Reconstruct an encoded PNG from raw RGBA pixel data.
 *
 * @param raw - Raw RGBA pixel buffer.
 * @param width - Image width.
 * @param height - Image height.
 * @returns PNG-encoded buffer.
 */
export async function fromRawRGBA(
  raw: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp(raw, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * Extract the alpha channel from an RGBA image as a single-channel
 * grayscale buffer. Each pixel is one byte (0 = transparent, 255 = opaque).
 *
 * @param buffer - Encoded RGBA image.
 * @returns Single-channel grayscale buffer representing the alpha mask.
 */
export async function extractAlpha(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer).ensureAlpha().extractChannel(3).raw().toBuffer();
}

/**
 * Apply an external alpha mask to an image. The mask must be a
 * single-channel grayscale buffer with the same width/height as the image.
 *
 * @param buffer - Source image (any format).
 * @param alphaMask - Single-channel grayscale buffer (same dimensions).
 * @returns PNG with the applied alpha channel.
 */
export async function applyAlpha(
  buffer: Buffer,
  alphaMask: Buffer,
): Promise<Buffer> {
  const { data, width, height } = await toRawRGBA(buffer);

  const pixelCount = width * height;
  if (alphaMask.length !== pixelCount) {
    throw new Error(
      `Alpha mask size (${alphaMask.length}) does not match image pixel count (${pixelCount})`,
    );
  }

  // Overwrite the alpha byte of every pixel
  for (let i = 0; i < pixelCount; i++) {
    data[i * 4 + 3] = alphaMask[i];
  }

  return fromRawRGBA(data, width, height);
}

/**
 * Find the tight bounding box of non-transparent pixels in an RGBA image.
 *
 * @param buffer - Encoded RGBA image.
 * @param alphaThreshold - Minimum alpha value to consider "non-transparent".
 *   Default 1 (any non-zero alpha).
 * @returns Bounding box `{ left, top, width, height }`, or `null` if the
 *   image is fully transparent.
 */
export async function findAlphaBoundingBox(
  buffer: Buffer,
  alphaThreshold: number = 1,
): Promise<{ left: number; top: number; width: number; height: number } | null> {
  const { data, width, height } = await toRawRGBA(buffer);

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha >= alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return null; // fully transparent

  return {
    left: minX,
    top: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}
