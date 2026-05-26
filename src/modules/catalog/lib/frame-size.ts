/**
 * Eyewear frame-size parsing.
 *
 * Factories supply Jaxy's frames with physical dimensions as a string like
 * "51口22 145" — lens-width 口 bridge-width temple-length, in millimetres.
 * Sometimes the format has a 4th value (lens height) and the separators
 * vary widely between suppliers ("x", "X", "×", "-", "□", whitespace).
 *
 * This module accepts the raw string verbatim and returns the four parsed
 * fields plus a round-trip formatter. Both are pure functions with no
 * dependencies so they can be called from the catalog UI, the MCP server,
 * batch import scripts, and tests alike.
 */

export interface FrameSize {
  lensWidth: number;
  bridgeWidth: number;
  templeLength: number;
  /** Some factories include a 4th value for lens height; optional. */
  lensHeight?: number;
}

/**
 * Sanity ranges per dimension (millimetres). Values outside these are
 * almost certainly mis-parsed (e.g. someone typed inches, swapped two
 * fields, or pasted garbage). Returning null on out-of-range lets callers
 * flag the input for manual review instead of writing nonsense.
 */
const RANGES = {
  lensWidth: [30, 80] as const,
  bridgeWidth: [10, 30] as const,
  templeLength: [100, 170] as const,
  lensHeight: [20, 70] as const,
};

function inRange(value: number, [min, max]: readonly [number, number]): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Parse a factory dimension string into structured fields. Returns null
 * when the string can't be confidently resolved to 3–4 valid integers in
 * the expected ranges — callers should surface that as a "couldn't parse,
 * enter manually" prompt rather than persisting bad data.
 *
 * Accepts: "51口22 145", "51-22-145", "51x22x145", "51X22X145",
 * "51×22×145", "51 22 145", "51 22 145 38" (with lens height), and
 * combinations thereof. Surrounding whitespace + "mm" suffix tolerated.
 */
export function parseFrameSize(raw: string | null | undefined): FrameSize | null {
  if (!raw) return null;
  // Normalise: strip mm suffix, collapse every recognised separator into a
  // single space, then split on whitespace. Anything not matched as a
  // separator OR a digit gets stripped, so stray characters don't poison
  // the split.
  const cleaned = String(raw)
    .replace(/\bmm\b/gi, "")
    .replace(/[口□xX×\-–—,/|]/g, " ")
    .replace(/[^\d\s.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const parts = cleaned
    .split(" ")
    .map((p) => Number.parseInt(p, 10))
    .filter((n) => Number.isFinite(n));
  if (parts.length < 3 || parts.length > 4) return null;

  const [lensWidth, bridgeWidth, templeLength, lensHeight] = parts;
  if (!inRange(lensWidth, RANGES.lensWidth)) return null;
  if (!inRange(bridgeWidth, RANGES.bridgeWidth)) return null;
  if (!inRange(templeLength, RANGES.templeLength)) return null;
  if (lensHeight != null && !inRange(lensHeight, RANGES.lensHeight)) return null;

  const result: FrameSize = { lensWidth, bridgeWidth, templeLength };
  if (lensHeight != null) result.lensHeight = lensHeight;
  return result;
}

/**
 * Format frame-size fields back to a human-readable string. Uses the "口"
 * separator to match how factories present it, plus a space + temple
 * length per industry convention. Lens height (when present) is appended
 * with a slash.
 *
 *   formatFrameSize({ lensWidth: 51, bridgeWidth: 22, templeLength: 145 })
 *     === "51口22 145"
 *   formatFrameSize({ lensWidth: 51, bridgeWidth: 22, templeLength: 145, lensHeight: 38 })
 *     === "51口22 145 / 38"
 */
export function formatFrameSize(size: FrameSize | null | undefined): string {
  if (!size) return "";
  const base = `${size.lensWidth}口${size.bridgeWidth} ${size.templeLength}`;
  return size.lensHeight != null ? `${base} / ${size.lensHeight}` : base;
}
