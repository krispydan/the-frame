/**
 * Cloudflare R2 storage backend (S3-compatible API).
 *
 * ALL media in The Frame — product images, AI images, videos, clips,
 * renders — will live in one R2 bucket, keyed by prefix:
 *   images/…     catalog + AI images (was IMAGES_PATH volume)
 *   videos/…     clips, sources, renders (was VIDEOS_PATH volume)
 *
 * Two reasons R2 is the right home:
 *   1. Direct browser uploads via presigned PUT URLs — large videos no
 *      longer stream through (and OOM) the Next.js server.
 *   2. Public CDN serving — media URLs point straight at R2's edge
 *      (public bucket / custom domain), off the app server entirely.
 *
 * DORMANT until configured: isR2Configured() is false unless all of
 * R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET
 * are set, so local dev, tests, and current prod keep using the volume
 * until the cutover. Signing uses aws4fetch (tiny SigV4 wrapper —
 * Cloudflare's own recommended client).
 */
import { AwsClient } from "aws4fetch";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Public base for serving, e.g. https://media.getjaxy.com or a
   *  https://pub-xxxx.r2.dev dev URL. No trailing slash. */
  publicBaseUrl: string | null;
}

/** Trim + strip surrounding quotes (Railway UI sometimes keeps literal
 *  quotes) + drop anything after a comma (guards the common "crammed
 *  multiple vars into one" mistake). */
function cleanEnv(v: string | undefined): string | undefined {
  if (v == null) return undefined;
  let s = v.trim().replace(/^["']|["']$/g, "").trim();
  const comma = s.indexOf(",");
  if (comma >= 0) s = s.slice(0, comma).trim();
  return s || undefined;
}

export function readR2Config(): R2Config | null {
  const accountId = cleanEnv(process.env.R2_ACCOUNT_ID);
  const accessKeyId = cleanEnv(process.env.R2_ACCESS_KEY_ID);
  const secretAccessKey = cleanEnv(process.env.R2_SECRET_ACCESS_KEY);
  const bucket = cleanEnv(process.env.R2_BUCKET);
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    publicBaseUrl: cleanEnv(process.env.R2_PUBLIC_BASE_URL)?.replace(/\/+$/, "") || null,
  };
}

export function isR2Configured(): boolean {
  return readR2Config() !== null;
}

/** S3 endpoint for the bucket. Path-style, which R2 supports. */
function bucketEndpoint(cfg: R2Config): string {
  return `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}`;
}

/** Normalize a storage key: no leading slash, forward slashes only. */
export function normalizeKey(key: string): string {
  return key.replace(/^[/\\]+/, "").replace(/\\/g, "/");
}

let cachedClient: { client: AwsClient; cfg: R2Config } | null = null;

function client(): { client: AwsClient; cfg: R2Config } {
  const cfg = readR2Config();
  if (!cfg) throw new Error("R2 not configured (set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET)");
  if (cachedClient && cachedClient.cfg.accessKeyId === cfg.accessKeyId && cachedClient.cfg.bucket === cfg.bucket) {
    return cachedClient;
  }
  const c = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: "auto", // R2 ignores region but SigV4 requires one
  });
  cachedClient = { client: c, cfg };
  return cachedClient;
}

function objectUrl(cfg: R2Config, key: string): string {
  return `${bucketEndpoint(cfg)}/${normalizeKey(key)}`;
}

// ── Server-side operations ──

/** Upload bytes (processed outputs: normalized clips, posters, renders). */
export async function r2Put(key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> {
  const { client: c, cfg } = client();
  const res = await c.fetch(objectUrl(cfg, key), {
    method: "PUT",
    // Buffer/Uint8Array are valid fetch bodies at runtime; the cast side-
    // steps TS 5.7's strict ArrayBuffer-vs-ArrayBufferLike BodyInit typing.
    body: body as unknown as BodyInit,
    headers: { "Content-Type": contentType },
  });
  if (!res.ok) {
    throw new Error(`R2 PUT ${key} failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }
}

/** Download bytes (e.g. pull a raw source to disk for ffmpeg). */
export async function r2Get(key: string): Promise<Buffer> {
  const { client: c, cfg } = client();
  const res = await c.fetch(objectUrl(cfg, key), { method: "GET" });
  if (!res.ok) throw new Error(`R2 GET ${key} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function r2Head(key: string): Promise<{ exists: boolean; size: number; contentType?: string }> {
  const { client: c, cfg } = client();
  const res = await c.fetch(objectUrl(cfg, key), { method: "HEAD" });
  if (res.status === 404) return { exists: false, size: 0 };
  if (!res.ok) throw new Error(`R2 HEAD ${key} failed: ${res.status}`);
  return {
    exists: true,
    size: parseInt(res.headers.get("content-length") || "0", 10),
    contentType: res.headers.get("content-type") || undefined,
  };
}

export async function r2Delete(key: string): Promise<void> {
  const { client: c, cfg } = client();
  const res = await c.fetch(objectUrl(cfg, key), { method: "DELETE" });
  // R2 returns 204 on delete, 404 if already gone — both fine.
  if (!res.ok && res.status !== 404) {
    throw new Error(`R2 DELETE ${key} failed: ${res.status}`);
  }
}

/**
 * Presigned PUT URL for a DIRECT browser upload — the whole point of
 * the migration. The browser PUTs the file straight to R2; the file
 * never touches the Next.js server, so no memory buffering / body
 * limits / proxy timeouts.
 */
export async function r2PresignPut(key: string, contentType: string, expiresSec = 3600): Promise<string> {
  const { client: c, cfg } = client();
  const url = new URL(objectUrl(cfg, key));
  url.searchParams.set("X-Amz-Expires", String(expiresSec));
  const signed = await c.sign(
    new Request(url, { method: "PUT", headers: { "Content-Type": contentType } }),
    { aws: { signQuery: true } },
  );
  return signed.url;
}

/**
 * The URL to store on the record + serve to browsers / marketplaces.
 * Prefers the public CDN base; falls back to the app proxy route when
 * no public base is set (private-bucket mode).
 */
export function r2PublicUrl(key: string): string {
  const cfg = readR2Config();
  const k = normalizeKey(key);
  if (cfg?.publicBaseUrl) return `${cfg.publicBaseUrl}/${k}`;
  return `/api/media/${k}`;
}
