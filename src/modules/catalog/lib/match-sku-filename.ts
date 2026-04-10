/**
 * Pure SKU auto-matcher for uploaded image filenames.
 *
 * Pattern: "<sku>-<colorName>-<angle>.<ext>" where sku is like "84002",
 * colorName is like "Beige" (or "Tortoise Shell"), and angle is
 * optional. Matching is case-insensitive and normalizes underscores
 * and spaces to hyphens before comparison. When multiple SKUs could
 * match, the longest prefix wins — so "84002-Beige" beats "84002".
 *
 * Kept in its own module (not uppy-uploader.tsx) so it can be
 * unit-tested in a node environment without dragging React, Uppy,
 * or sonner into the test bundle.
 */

export interface UploaderSku {
  id: string;
  sku: string | null;
  colorName: string | null;
}

export function matchSkuFromFilename(
  filename: string,
  skus: UploaderSku[],
): string | null {
  if (!filename) return null;

  const stem = filename.replace(/\.[a-z0-9]+$/i, "");
  // Normalize separators: "_" and spaces → "-"
  const normalized = stem.replace(/[_\s]+/g, "-").toLowerCase();

  const candidates = skus
    .map((s) => {
      if (!s.sku) return null;
      const sku = s.sku.toLowerCase();
      const color = (s.colorName ?? "").toLowerCase().replace(/\s+/g, "-");
      const prefix = color ? `${sku}-${color}` : sku;
      return { id: s.id, prefix };
    })
    .filter((s): s is { id: string; prefix: string } => s !== null);

  const matches = candidates
    .filter(
      (c) => normalized === c.prefix || normalized.startsWith(`${c.prefix}-`),
    )
    .sort((a, b) => b.prefix.length - a.prefix.length);

  return matches[0]?.id ?? null;
}
