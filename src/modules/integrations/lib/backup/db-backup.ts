/**
 * Daily SQLite → Cloudflare R2 database backup.
 *
 * Flow (all memory-safe — this app has a tight memory ceiling):
 *   1. sqlite.backup() — a CONSISTENT online snapshot of the live DB, copied in
 *      chunks across event-loop turns (does NOT freeze the app like a
 *      synchronous VACUUM would).
 *   2. gzip, streamed disk→disk (never buffers the DB in RAM).
 *   3. stream-upload the .gz to R2 (r2PutFile streams from disk).
 *   4. prune backups older than the retention window.
 *
 * ── SECURITY ─────────────────────────────────────────────────────────────
 * A database dump contains everything — customers, orders, contacts. It must
 * NEVER land in the public media bucket (which is served over a public CDN via
 * R2_PUBLIC_BASE_URL). So backups go to a SEPARATE, PRIVATE bucket named by
 * R2_BACKUP_BUCKET, accessed only through signed S3 requests — never a public
 * URL. If R2_BACKUP_BUCKET is unset, this refuses to run rather than risk
 * writing the dump into the public bucket. Create R2_BACKUP_BUCKET with NO
 * r2.dev public URL and NO custom domain binding.
 */
import path from "path";
import { createReadStream, createWriteStream, statSync, mkdirSync } from "fs";
import { unlink } from "fs/promises";
import { createGzip } from "zlib";
import { pipeline } from "stream/promises";
import { sqlite } from "@/lib/db";
import { isR2Configured, r2PutFile, r2List, r2Delete } from "@/lib/storage/r2";

const BACKUP_PREFIX = "db/";
const DEFAULT_RETENTION_DAYS = 30;

/** The DB file location — mirrors src/lib/db.ts so temp snapshots land on the
 *  same volume (guaranteed comparable free space, same filesystem). */
const DB_PATH =
  process.env.DATABASE_PATH || process.env.DATABASE_URL || path.join(process.cwd(), "data", "the-frame.db");

/** The private, non-public bucket dumps go to. Falls back to nothing on
 *  purpose — we refuse rather than use the public media bucket. */
function backupBucket(): string | null {
  const b = process.env.R2_BACKUP_BUCKET?.trim().replace(/^["']|["']$/g, "").trim();
  return b || null;
}

function retentionDays(): number {
  const v = Number(process.env.DB_BACKUP_RETENTION_DAYS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_RETENTION_DAYS;
}

export interface BackupResult {
  ok: boolean;
  key?: string;
  bytes?: number;
  retentionDays: number;
  pruned: string[];
  skipped?: string;
}

export async function runDatabaseBackup(): Promise<BackupResult> {
  const days = retentionDays();
  if (!isR2Configured()) {
    return { ok: false, retentionDays: days, pruned: [], skipped: "R2 not configured" };
  }
  const bucket = backupBucket();
  if (!bucket) {
    return {
      ok: false,
      retentionDays: days,
      pruned: [],
      skipped: "R2_BACKUP_BUCKET not set — refusing to write a DB dump to the public media bucket. Create a private bucket (no public URL) and set R2_BACKUP_BUCKET.",
    };
  }

  const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const tmpDir = path.join(path.dirname(DB_PATH), ".backup-tmp");
  mkdirSync(tmpDir, { recursive: true });
  const snapPath = path.join(tmpDir, `frame-db-${stamp}.sqlite`);
  const gzPath = `${snapPath}.gz`;

  try {
    // 1. Consistent online snapshot (chunked; won't block the event loop).
    await sqlite.backup(snapPath);
    // 2. gzip, streamed disk→disk (no full-file buffer in memory).
    await pipeline(createReadStream(snapPath), createGzip({ level: 6 }), createWriteStream(gzPath));
    // 3. stream-upload to the PRIVATE backup bucket.
    const key = `${BACKUP_PREFIX}the-frame-${stamp}.db.gz`;
    const bytes = await r2PutFile(key, gzPath, "application/gzip", bucket);
    // 4. prune old backups (same private bucket).
    const pruned = await pruneOldBackups(days, bucket);
    return { ok: true, key, bytes, retentionDays: days, pruned };
  } finally {
    await unlink(snapPath).catch(() => {});
    await unlink(gzPath).catch(() => {});
  }
}

const KEY_DATE_RE = /the-frame-(\d{4}-\d{2}-\d{2})\.db\.gz$/;

/** Delete backups older than `days`. Parses the date out of the object key so
 *  it never depends on R2's own timestamps. */
export async function pruneOldBackups(days: number, bucket: string): Promise<string[]> {
  const objs = await r2List(BACKUP_PREFIX, 10_000, bucket);
  const cutoff = Date.now() - days * 86_400_000;
  const toDelete: string[] = [];
  for (const o of objs) {
    const m = KEY_DATE_RE.exec(o.key);
    if (!m) continue;
    const t = Date.parse(`${m[1]}T00:00:00Z`);
    if (Number.isFinite(t) && t < cutoff) toDelete.push(o.key);
  }
  for (const key of toDelete) await r2Delete(key, bucket);
  return toDelete;
}

/** List existing backups (newest first) — for the ops endpoint / verification. */
export async function listBackups(): Promise<Array<{ key: string; size: number }>> {
  const bucket = backupBucket();
  if (!isR2Configured() || !bucket) return [];
  return (await r2List(BACKUP_PREFIX, 10_000, bucket)).sort((a, b) => (a.key < b.key ? 1 : -1));
}
