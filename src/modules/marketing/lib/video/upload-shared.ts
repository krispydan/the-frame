/**
 * Shared helpers for the video upload routes (clips + sources), used by
 * both the presigned direct-to-R2 path and the through-server fallback.
 */
import path from "path";
import { sqlite } from "@/lib/db";

/** Extensions we accept for clips/sources. */
export const ALLOWED_VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);

/** Lower-case extension (with dot) from a file name, defaulting to .mp4. */
export function extFromName(fileName: string): string {
  return path.extname(fileName || "").toLowerCase() || ".mp4";
}

/** MIME type for a video extension (what we sign the PUT with). */
export function contentTypeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".mp4":
    case ".m4v":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".mkv":
      return "video/x-matroska";
    default:
      return "application/octet-stream";
  }
}

/** A content-address checksum is 16 lowercase hex chars (sha256 slice). */
export function isValidChecksum(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{16}$/.test(v);
}

export function parseSkuIds(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    /* comma fallback */
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Resolve a category id-or-slug to an id (or null). */
export function resolveCategoryId(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  const row = sqlite
    .prepare(`SELECT id FROM marketing_video_clip_categories WHERE (id = ? OR slug = ?) AND archived = 0`)
    .get(raw, raw) as { id: string } | undefined;
  return row?.id ?? null;
}
