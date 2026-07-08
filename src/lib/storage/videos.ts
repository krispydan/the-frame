/**
 * Local filesystem storage for marketing video assets (clips + renders).
 *
 * In production this points at the Railway volume mounted at /data
 * (env: VIDEOS_PATH=/data/videos). In local dev it falls back to
 * <repo>/data/videos so uploads work without extra setup.
 *
 * Mirrors src/lib/storage/local.ts (images): all public helpers take
 * paths RELATIVE to VIDEOS_PATH and resolve them safely (no traversal
 * outside the root).
 *
 * Volume layout:
 *   clips/raw/{checksum}.{ext}            original upload bytes, content-addressed
 *   clips/normalized/{checksum}_v{N}.mp4  canonical 1080x1920@30 H.264+AAC
 *   clips/normalized/{checksum}_v{N}_muted.mp4  same video stream, silent audio
 *   clips/posters/{checksum}.jpg          clip thumbnail
 *   renders/{YYYY-MM}/{postId}.mp4|.jpg   final posts + poster frames
 *   tmp/                                  in-flight renders; atomic rename into place
 */
import { mkdir, writeFile, unlink, stat, readFile, rename } from "fs/promises";
import path from "path";
import { tmpdir } from "os";
import {
  saveMedia,
  readMedia,
  mediaStat,
  deleteMedia,
  materializeMedia,
  storeLocalFile,
  mediaUrl,
  mediaOnR2,
  presignUpload,
} from "./media";

/**
 * Read VIDEOS_PATH at call time, not module load time, so tests can set
 * process.env.VIDEOS_PATH before any test runs without import-hoisting
 * surprises. (Same pattern as imagesRootFn in local.ts.)
 */
function videosRootFn(): string {
  return (
    process.env.VIDEOS_PATH ||
    path.join(process.cwd(), "data", "videos")
  );
}

/** Current VIDEOS_ROOT resolved from env. */
export function videosRoot(): string {
  return videosRootFn();
}

/**
 * Resolve a relative path against VIDEOS_ROOT and verify the result is
 * still contained within the root. Throws on traversal attempts.
 */
export function getVideoFullPath(relPath: string): string {
  const normalized = relPath.replace(/^[/\\]+/, "");
  const resolvedRoot = path.resolve(videosRootFn());
  const resolvedFull = path.resolve(resolvedRoot, normalized);

  const rel = path.relative(resolvedRoot, resolvedFull);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path traversal rejected: ${relPath}`);
  }
  return resolvedFull;
}

// Video keys in the unified media space are "videos/" + the relative
// path. The DB keeps storing the unprefixed relative path (e.g.
// "clips/raw/ab.mp4"); the prefix is added only at the storage boundary,
// so existing rows and the local-volume layout are untouched.
function vkey(relPath: string): string {
  return `videos/${relPath.replace(/^[/\\]+/, "")}`;
}

/** MIME type from a video/poster extension. */
export function videoContentType(relPath: string): string {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mkv") return "video/x-matroska";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".txt") return "text/plain";
  return "application/octet-stream";
}

/** Store a buffer (routes to R2 when configured, else the volume). */
export async function saveVideo(buffer: Buffer, relPath: string): Promise<void> {
  await saveMedia(vkey(relPath), buffer, videoContentType(relPath));
}

/** Read a stored video/poster as a buffer. */
export async function readVideo(relPath: string): Promise<Buffer> {
  return readMedia(vkey(relPath));
}

/** Delete a stored file. Silent if already gone. */
export async function deleteVideo(relPath: string): Promise<void> {
  await deleteMedia(vkey(relPath));
}

/** Return { size, exists } for a stored file. Never throws. */
export async function videoStat(relPath: string): Promise<{ size: number; exists: boolean }> {
  const s = await mediaStat(vkey(relPath));
  return { size: s.size, exists: s.exists };
}

/**
 * Ensure a raw/stored video is on local disk for ffmpeg and return its
 * path + a cleanup(). On R2 it downloads to a temp file; locally it's
 * the volume path. Always call cleanup() when done.
 */
export async function materializeVideo(relPath: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  return materializeMedia(vkey(relPath));
}

/** Upload/move an ffmpeg output (a local temp file) into storage. */
export async function storeVideoFile(tmpAbsPath: string, relPath: string): Promise<void> {
  await storeLocalFile(tmpAbsPath, vkey(relPath), videoContentType(relPath));
}

/** A scratch path in the OS temp dir for ffmpeg working files (never
 *  the volume — keeps R2 mode diskless beyond transient temps). */
export function videoScratchPath(name: string): string {
  return path.join(tmpdir(), `vid-${Date.now()}-${Math.round(Math.random() * 1e9)}-${name.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
}

/**
 * Ensure the directory for a relative path exists and return the full
 * path — used by ffmpeg which writes output files itself.
 */
export async function ensureVideoDir(relPath: string): Promise<string> {
  const full = getVideoFullPath(relPath);
  await mkdir(path.dirname(full), { recursive: true });
  return full;
}

/**
 * Atomically move a finished artifact from tmp/ into its final home.
 * rename() is atomic on the same filesystem (both live on the volume).
 */
export async function promoteVideo(tmpRelPath: string, finalRelPath: string): Promise<void> {
  const from = getVideoFullPath(tmpRelPath);
  const to = await ensureVideoDir(finalRelPath);
  await rename(from, to);
}

// ── Path helpers (all return VIDEOS_ROOT-relative paths) ──

export function rawClipPath(checksum: string, ext: string): string {
  return `clips/raw/${checksum}.${ext.replace(/^\./, "")}`;
}

/** Raw footage sources the auto-clipper splits into clips. */
export function sourcePath(checksum: string, ext: string): string {
  return `sources/${checksum}.${ext.replace(/^\./, "")}`;
}

export function normalizedClipPath(checksum: string, version: number): string {
  return `clips/normalized/${checksum}_v${version}.mp4`;
}

export function mutedClipPath(checksum: string, version: number): string {
  return `clips/normalized/${checksum}_v${version}_muted.mp4`;
}

export function clipPosterPath(checksum: string): string {
  return `clips/posters/${checksum}.jpg`;
}

/** renders are grouped by month for easy hygiene sweeps. */
export function renderPath(postId: string, yyyymm: string, ext: "mp4" | "jpg"): string {
  return `renders/${yyyymm}/${postId}.${ext}`;
}

export function tmpPath(name: string): string {
  return `tmp/${name}`;
}

/** Public URL for a stored video asset — R2 CDN when configured, else
 *  the /api/videos serving route. */
export function videoUrl(relPath: string): string {
  return mediaUrl(vkey(relPath));
}

/** True when direct browser→R2 uploads are available (R2 configured). */
export function videosDirectUpload(): boolean {
  return mediaOnR2();
}

/** Presigned PUT URL for a direct browser upload of a video asset.
 *  R2-only — throws if not configured (callers gate on
 *  videosDirectUpload()). */
export async function presignVideoUpload(
  relPath: string,
  contentType: string,
  expiresSec = 3600,
): Promise<string> {
  return presignUpload(vkey(relPath), contentType, expiresSec);
}
