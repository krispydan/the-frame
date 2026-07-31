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

/**
 * sha256 of a Blob, first 16 hex chars — matches the server's checksum.
 *
 * crypto.subtle has no streaming digest, so the whole file becomes one
 * ArrayBuffer. At 400MB a file, several of those at once is enough to
 * kill the tab — and a dead tab mid-batch is one of the ways uploads
 * silently went missing. Hashing is therefore serialized: one file in
 * memory at a time, no matter how many Uppy runs in parallel.
 */
let hashChain: Promise<unknown> = Promise.resolve();
export async function sha256Hex16(blob: Blob): Promise<string> {
  const run = hashChain.then(async () => {
    const buf = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);
  });
  // Keep the chain alive even if this hash throws.
  hashChain = run.catch(() => {});
  return run;
}

// ── Preflight ──

export type PreflightVerdict = "skip" | "repair" | "upload";

export interface PreflightResult {
  fileName: string;
  sizeBytes: number;
  verdict: PreflightVerdict;
  reason: string;
  kind: "clip" | "source" | null;
  id: string | null;
  status: string | null;
  clipCount?: number;
}

export interface PreflightResponse {
  results: PreflightResult[];
  summary: { total: number; skip: number; repair: number; upload: number };
}

const PREFLIGHT_ENDPOINT = "/api/v1/marketing/videos/uploads/preflight";

/**
 * Ask the server which of these files it already has, BEFORE any bytes
 * (or even a hash) are computed. Returns null if the check itself fails —
 * callers then upload everything, since the checksum gate at /register
 * still prevents a duplicate row. Failing open costs bandwidth; failing
 * closed would silently drop real footage.
 */
export async function preflight(
  files: Array<{ fileName: string; sizeBytes: number }>,
): Promise<PreflightResponse | null> {
  if (files.length === 0) return { results: [], summary: { total: 0, skip: 0, repair: 0, upload: 0 } };
  try {
    const res = await fetch(PREFLIGHT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files }),
    });
    if (!res.ok) return null;
    return (await res.json()) as PreflightResponse;
  } catch {
    return null;
  }
}

/**
 * POST with retries. Used for /register, whose failure is the worst kind:
 * the bytes are already in R2, so losing this call means paying for a
 * file the app doesn't know exists.
 *
 * `keepalive` lets the request outlive the page — closing the tab right
 * after the last upload no longer strands it. (The 64KB keepalive body
 * cap is irrelevant; this body is a few hundred bytes of JSON.)
 */
export async function postWithRetry(
  url: string,
  body: unknown,
  attempts = 3,
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  let lastError = "";
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) return { ok: true, data };
      // 4xx other than 409 is a permanent rejection — retrying can't help.
      if (res.status < 500 && res.status !== 409) return { ok: false, data };
      lastError = String(data.error ?? res.status);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** i));
  }
  return { ok: false, data: { error: lastError } };
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
