/**
 * Unified media storage facade.
 *
 * ALL media (images + videos) go through here. When R2 is configured
 * (R2_* env set) it's the backend; otherwise the local Railway volume
 * is used, so dev/tests and pre-migration prod keep working unchanged.
 *
 * Keys are backend-agnostic relative paths (e.g. "videos/clips/raw/ab.mp4",
 * "images/{sku}/square/cd.jpg"). The R2 backend stores them as-is; the
 * local backend maps a key's first segment to the matching volume root
 * (videos/* → VIDEOS_PATH, images/* → IMAGES_PATH) so existing on-disk
 * layouts are preserved until the file migration runs.
 */
import { mkdir, writeFile, readFile, unlink, stat, rename } from "fs/promises";
import path from "path";
import os from "os";
import {
  isR2Configured,
  r2Put,
  r2Get,
  r2Head,
  r2Delete,
  r2PresignPut,
  r2PublicUrl,
  normalizeKey,
} from "./r2";

export function mediaOnR2(): boolean {
  return isR2Configured();
}

// ── Local backend: map a key to a volume path ──

function localRootFor(key: string): string {
  const k = normalizeKey(key);
  if (k.startsWith("videos/")) {
    return process.env.VIDEOS_PATH || path.join(process.cwd(), "data", "videos");
  }
  if (k.startsWith("images/")) {
    return process.env.IMAGES_PATH || path.join(process.cwd(), "data", "images");
  }
  // default bucket for anything else
  return process.env.MEDIA_PATH || path.join(process.cwd(), "data", "media");
}

/** Local absolute path for a key (strips the top-level prefix so the
 *  on-disk layout matches the pre-R2 volume roots). Traversal-guarded. */
function localPath(key: string): string {
  const k = normalizeKey(key);
  const root = path.resolve(localRootFor(k));
  const rel = k.replace(/^(videos|images|media)\//, "");
  const full = path.resolve(root, rel);
  const within = path.relative(root, full);
  if (within.startsWith("..") || path.isAbsolute(within)) {
    throw new Error(`Path traversal rejected: ${key}`);
  }
  return full;
}

// ── Public API ──

export async function saveMedia(key: string, body: Buffer, contentType: string): Promise<void> {
  if (mediaOnR2()) {
    await r2Put(key, body, contentType);
    return;
  }
  const full = localPath(key);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body);
}

export async function readMedia(key: string): Promise<Buffer> {
  if (mediaOnR2()) return r2Get(key);
  return readFile(localPath(key));
}

export async function mediaStat(key: string): Promise<{ exists: boolean; size: number }> {
  try {
    if (mediaOnR2()) {
      const h = await r2Head(key);
      return { exists: h.exists, size: h.size };
    }
    const s = await stat(localPath(key));
    return { exists: true, size: s.size };
  } catch {
    return { exists: false, size: 0 };
  }
}

export async function deleteMedia(key: string): Promise<void> {
  if (mediaOnR2()) {
    await r2Delete(key);
    return;
  }
  try {
    await unlink(localPath(key));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

/** Presigned PUT URL for direct browser upload. R2-only — the local
 *  backend has no direct-upload path (callers gate on mediaOnR2()). */
export async function presignUpload(key: string, contentType: string, expiresSec = 3600): Promise<string> {
  if (!mediaOnR2()) throw new Error("Direct upload requires R2 (not configured)");
  return r2PresignPut(key, contentType, expiresSec);
}

/** The URL to store on a record + serve. R2 public CDN URL when
 *  configured; otherwise the app's media/serving route. */
export function mediaUrl(key: string): string {
  const k = normalizeKey(key);
  if (mediaOnR2()) return r2PublicUrl(k);
  // Local dev/serving: reuse the existing per-type routes.
  if (k.startsWith("videos/")) return `/api/videos/${k.replace(/^videos\//, "")}`;
  if (k.startsWith("images/")) return `/api/images/${k.replace(/^images\//, "")}`;
  return `/api/media/${k}`;
}

/**
 * Ensure a key's bytes are on local disk and return a path ffmpeg/sharp
 * can read. R2 objects are downloaded to a temp file; local objects
 * return their volume path directly. Always call cleanup() when done —
 * it removes the temp file (no-op for local paths).
 */
export async function materializeMedia(key: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  if (!mediaOnR2()) {
    return { path: localPath(key), cleanup: async () => {} };
  }
  const bytes = await r2Get(key);
  const tmp = path.join(os.tmpdir(), `media-${Date.now()}-${Math.round(Math.random() * 1e9)}-${path.basename(key)}`);
  await writeFile(tmp, bytes);
  return {
    path: tmp,
    cleanup: async () => {
      await unlink(tmp).catch(() => {});
    },
  };
}

/**
 * Store a file that ffmpeg just wrote to a local temp path. On R2 this
 * uploads then removes the temp; locally it moves it into the volume.
 */
export async function storeLocalFile(tmpPath: string, key: string, contentType: string): Promise<void> {
  if (mediaOnR2()) {
    const bytes = await readFile(tmpPath);
    await r2Put(key, bytes, contentType);
    await unlink(tmpPath).catch(() => {});
    return;
  }
  const full = localPath(key);
  await mkdir(path.dirname(full), { recursive: true });
  await rename(tmpPath, full).catch(async () => {
    // cross-device rename fails → copy+unlink
    await writeFile(full, await readFile(tmpPath));
    await unlink(tmpPath).catch(() => {});
  });
}
