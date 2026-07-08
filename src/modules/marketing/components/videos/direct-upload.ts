/**
 * Browser helper for direct-to-R2 uploads via Uppy's AwsS3 plugin.
 *
 * The flow per file:
 *   1. sha256 the bytes in the browser (content-address, same 16-hex
 *      slice the server uses) — lets the server dedupe + name the object
 *      without ever seeing the bytes.
 *   2. getUploadParameters → POST /clips/presign → presigned PUT URL.
 *   3. Uppy PUTs the file straight to R2 (never through our server).
 *   4. after upload → POST /clips/register → DB row + normalize job.
 *
 * The whole point: a 400MB file never streams through / buffers in the
 * Next.js server, which is what OOM'd and broke uploads.
 */

/** sha256 of a Blob, first 16 hex chars — matches the server's checksum. */
export async function sha256Hex16(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export interface PresignResponse {
  direct: boolean;
  uploadUrl?: string;
  key?: string;
  checksum?: string;
  headers?: Record<string, string>;
  deduped?: boolean;
  id?: string;
  status?: string;
}

/** Probe whether the server offers direct upload (R2 configured). Uses a
 *  throwaway checksum so no state is created. */
export async function directUploadAvailable(presignEndpoint: string): Promise<boolean> {
  try {
    const res = await fetch(presignEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "probe.mp4", checksum: "0".repeat(16) }),
    });
    // 409 => R2 off (through-server fallback). 200 => direct available.
    if (res.status === 409) return false;
    const body = (await res.json().catch(() => ({}))) as PresignResponse;
    return body.direct === true;
  } catch {
    return false;
  }
}
