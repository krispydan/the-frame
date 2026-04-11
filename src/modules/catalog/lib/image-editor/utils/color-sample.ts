/**
 * Corner pixel sampling and white background detection.
 *
 * Used by the threshold background removal system to auto-detect
 * appropriate threshold values from factory photos.
 */
import sharp from "sharp";

/** RGB color value (0-255 per channel). */
export interface RGBColor {
  r: number;
  g: number;
  b: number;
}

/** Result of sampling the four corners of an image. */
export interface CornerSamples {
  topLeft: RGBColor;
  topRight: RGBColor;
  bottomLeft: RGBColor;
  bottomRight: RGBColor;
  /** Average of all four corners. */
  average: RGBColor;
  /** Min channel value across the average (indicates how "white" the bg is). */
  minChannel: number;
}

/**
 * Size of the square region sampled at each corner, as a fraction of
 * the shortest image dimension. 5% means we sample a 5%-of-shortest-side
 * square from each corner.
 */
const CORNER_REGION_FRACTION = 0.05;

/**
 * Sample the average color of a small square region at each of the four
 * corners of an image.
 *
 * @param buffer - Image buffer (any format Sharp can decode).
 * @returns Corner sample results with per-corner and overall averages.
 */
export async function sampleCorners(buffer: Buffer): Promise<CornerSamples> {
  const meta = await sharp(buffer).metadata();
  const width = meta.width!;
  const height = meta.height!;
  const channels = meta.channels ?? 3;

  const regionSize = Math.max(
    4,
    Math.round(Math.min(width, height) * CORNER_REGION_FRACTION),
  );

  // Extract raw pixels once — faster than 4 separate extracts
  const { data } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const stride = width * 4; // RGBA

  const sampleRegion = (startX: number, startY: number): RGBColor => {
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    let count = 0;

    const endX = Math.min(startX + regionSize, width);
    const endY = Math.min(startY + regionSize, height);

    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const offset = y * stride + x * 4;
        rSum += data[offset];
        gSum += data[offset + 1];
        bSum += data[offset + 2];
        count++;
      }
    }

    return {
      r: Math.round(rSum / count),
      g: Math.round(gSum / count),
      b: Math.round(bSum / count),
    };
  };

  const topLeft = sampleRegion(0, 0);
  const topRight = sampleRegion(width - regionSize, 0);
  const bottomLeft = sampleRegion(0, height - regionSize);
  const bottomRight = sampleRegion(width - regionSize, height - regionSize);

  const average: RGBColor = {
    r: Math.round((topLeft.r + topRight.r + bottomLeft.r + bottomRight.r) / 4),
    g: Math.round((topLeft.g + topRight.g + bottomLeft.g + bottomRight.g) / 4),
    b: Math.round((topLeft.b + topRight.b + bottomLeft.b + bottomRight.b) / 4),
  };

  return {
    topLeft,
    topRight,
    bottomLeft,
    bottomRight,
    average,
    minChannel: Math.min(average.r, average.g, average.b),
  };
}

/**
 * Detect whether an image has a white (or near-white) background by
 * examining the four corner regions.
 *
 * @param buffer - Image buffer.
 * @param tolerance - How far below 255 each channel can be and still count
 *   as "white". Default 30 means channels >= 225 are considered white.
 * @returns `true` if the average corner color is within tolerance of white.
 */
export async function isWhiteBackground(
  buffer: Buffer,
  tolerance: number = 30,
): Promise<boolean> {
  const samples = await sampleCorners(buffer);
  const threshold = 255 - tolerance;
  return (
    samples.average.r >= threshold &&
    samples.average.g >= threshold &&
    samples.average.b >= threshold
  );
}
