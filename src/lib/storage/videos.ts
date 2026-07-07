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

/** Write a buffer to <VIDEOS_ROOT>/<relPath>, creating parent dirs as needed. */
export async function saveVideo(buffer: Buffer, relPath: string): Promise<void> {
  const full = getVideoFullPath(relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, buffer);
}

/** Read a stored video/poster as a buffer. Throws ENOENT if missing. */
export async function readVideo(relPath: string): Promise<Buffer> {
  const full = getVideoFullPath(relPath);
  return readFile(full);
}

/** Delete a stored file. Silent if the file is already gone. */
export async function deleteVideo(relPath: string): Promise<void> {
  const full = getVideoFullPath(relPath);
  try {
    await unlink(full);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

/** Return { size, exists } for a stored file. Never throws. */
export async function videoStat(relPath: string): Promise<{ size: number; exists: boolean }> {
  try {
    const full = getVideoFullPath(relPath);
    const s = await stat(full);
    return { size: s.size, exists: true };
  } catch {
    return { size: 0, exists: false };
  }
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

/** Public URL for a stored video asset (served by /api/videos/[...path]). */
export function videoUrl(relPath: string): string {
  return `/api/videos/${relPath.replace(/^[/\\]+/, "")}`;
}
