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

/**
 * Read IMAGES_PATH at call time, not module load time. This keeps
 * tests deterministic: they can set process.env.IMAGES_PATH before
 * any test runs without worrying about import hoisting.
 */
function imagesRootFn(): string {
  return (
    process.env.IMAGES_PATH ||
    path.join(process.cwd(), "data", "images")
  );
}

/**
 * Resolve a relative path against IMAGES_ROOT and verify the result is
 * still contained within the root. Throws on traversal attempts.
 */
export function getFullPath(relPath: string): string {
  // Strip any leading slashes so path.join treats it as relative
  const normalized = relPath.replace(/^[/\\]+/, "");
  const resolvedRoot = path.resolve(imagesRootFn());
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

/**
 * Current IMAGES_ROOT resolved from env. Function form (not const)
 * so tests can override process.env.IMAGES_PATH at runtime.
 */
export function imagesRoot(): string {
  return imagesRootFn();
}

// ── Image Editor path helpers ──

/**
 * Returns relative path for a pipeline stage artifact.
 * e.g. `<skuId>/no_bg/<checksum>.png`
 */
export function getStagePath(skuId: string, stage: string, checksum: string, ext: string): string {
  return `${skuId}/${stage}/${checksum}.${ext}`;
}

/**
 * Returns relative path for a variation artifact.
 * e.g. `<skuId>/variations/<checksum>_<label>.png`
 */
export function getVariationPath(skuId: string, checksum: string, label: string, ext: string): string {
  return `${skuId}/variations/${checksum}_${label}.${ext}`;
}

/**
 * Returns relative path for a collection image.
 * e.g. `collections/<productId>/<checksum>.jpg`
 */
export function getCollectionPath(productId: string, checksum: string, ext: string): string {
  return `collections/${productId}/${checksum}.${ext}`;
}
