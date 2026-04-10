/**
 * Local filesystem storage for catalog images.
 *
 * In production this points at the Railway volume mounted at /data
 * (env: IMAGES_PATH=/data/images). In local dev it falls back to
 * <repo>/data/images so uploads work without extra setup.
 *
 * All public helpers take paths RELATIVE to IMAGES_PATH and resolve
 * them safely (no traversal outside the root).
 */
import { mkdir, writeFile, unlink, stat, readFile } from "fs/promises";
import path from "path";

const IMAGES_ROOT =
  process.env.IMAGES_PATH ||
  path.join(process.cwd(), "data", "images");

/**
 * Resolve a relative path against IMAGES_ROOT and verify the result is
 * still contained within the root. Throws on traversal attempts.
 */
export function getFullPath(relPath: string): string {
  // Strip any leading slashes so path.join treats it as relative
  const normalized = relPath.replace(/^[/\\]+/, "");
  const resolvedRoot = path.resolve(IMAGES_ROOT);
  const resolvedFull = path.resolve(resolvedRoot, normalized);

  // Verify the resolved path is inside the root
  const rel = path.relative(resolvedRoot, resolvedFull);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path traversal rejected: ${relPath}`);
  }
  return resolvedFull;
}

/**
 * Write a buffer to <IMAGES_ROOT>/<relPath>, creating parent dirs as needed.
 */
export async function saveImage(buffer: Buffer, relPath: string): Promise<void> {
  const full = getFullPath(relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, buffer);
}

/**
 * Read a stored image as a buffer. Throws ENOENT if missing.
 */
export async function readImage(relPath: string): Promise<Buffer> {
  const full = getFullPath(relPath);
  return readFile(full);
}

/**
 * Delete a stored image. Silent if the file is already gone.
 */
export async function deleteImage(relPath: string): Promise<void> {
  const full = getFullPath(relPath);
  try {
    await unlink(full);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

/**
 * Return { size, exists } for a stored file. Never throws.
 */
export async function imageStat(relPath: string): Promise<{ size: number; exists: boolean }> {
  try {
    const full = getFullPath(relPath);
    const s = await stat(full);
    return { size: s.size, exists: true };
  } catch {
    return { size: 0, exists: false };
  }
}

export const imagesRoot = IMAGES_ROOT;
