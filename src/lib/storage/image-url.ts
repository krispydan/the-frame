/**
 * Single source of truth for catalog image URLs.
 *
 * In production: https://theframe.getjaxy.com/api/images/<relPath>
 * In local dev (NEXT_PUBLIC_IMAGE_BASE_URL unset): /api/images/<relPath>
 *
 * Override by setting NEXT_PUBLIC_IMAGE_BASE_URL in env. Must NOT have
 * a trailing slash.
 */
const DEFAULT_BASE = "https://theframe.getjaxy.com/api/images";

function getBase(): string {
  const raw = process.env.NEXT_PUBLIC_IMAGE_BASE_URL;
  if (raw && raw.length > 0) return raw.replace(/\/+$/, "");
  return DEFAULT_BASE;
}

/**
 * Convert a stored filePath (relative to IMAGES_ROOT) into a full CDN URL.
 * Handles legacy rows where filePath already starts with "http" or with
 * "data/images/" (the old Gemini generator wrote paths like that).
 */
export function catalogImageUrl(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
    return filePath;
  }
  // Strip legacy "data/images/" prefix if present
  const clean = filePath.replace(/^\/*(data\/images\/)?/, "");
  return `${getBase()}/${clean}`;
}
