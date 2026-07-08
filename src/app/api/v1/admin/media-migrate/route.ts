/**
 * GET /api/v1/admin/media-migrate
 *
 * Copy existing volume media into R2 at the mirrored key, so the corpus
 * that predates the R2 cutover serves from R2 too. Business-critical
 * discipline: copy-only (never deletes the volume file), idempotent
 * (skips objects already present with a matching size), and dry-run by
 * default so you see counts before anything is written.
 *
 *   ?type=images|videos   which volume to walk (default images)
 *   ?apply=1              actually copy (default: dry-run report only)
 *   ?limit=200           files per call (batch to avoid timeouts)
 *   ?cursor=<relPath>    resume after this path (from a prior nextCursor)
 *
 * Response: { type, apply, scanned, eligible, copied, skipped, failed[],
 *             nextCursor, done }
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { readdir, stat, readFile } from "fs/promises";
import path from "path";
import { isR2Configured, r2Head, r2Put } from "@/lib/storage/r2";

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".txt": "text/plain",
};

function rootFor(type: string): { root: string; prefix: string } {
  if (type === "videos") {
    return {
      root: process.env.VIDEOS_PATH || path.join(process.cwd(), "data", "videos"),
      prefix: "videos",
    };
  }
  return {
    root: process.env.IMAGES_PATH || path.join(process.cwd(), "data", "images"),
    prefix: "images",
  };
}

/** Recursively list files under root, returning root-relative POSIX paths. */
async function walk(root: string, sub = ""): Promise<string[]> {
  const dir = path.join(root, sub);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(...(await walk(root, rel)));
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

export async function GET(request: NextRequest) {
  if (!isR2Configured()) {
    return NextResponse.json({ error: "R2 is not configured" }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type") === "videos" ? "videos" : "images";
  const apply = searchParams.get("apply") === "1";
  const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 200, 1), 1000);
  const cursor = searchParams.get("cursor") || "";

  const { root, prefix } = rootFor(type);
  const all = (await walk(root)).sort();
  const start = cursor ? all.findIndex((p) => p > cursor) : 0;
  const startIdx = start === -1 ? all.length : start;
  const batch = all.slice(startIdx, startIdx + limit);

  let copied = 0;
  let skipped = 0;
  const failed: Array<{ path: string; error: string }> = [];

  for (const rel of batch) {
    const key = `${prefix}/${rel}`;
    try {
      const full = path.join(root, rel);
      const s = await stat(full);
      // Idempotent: already in R2 with the same size → skip.
      const head = await r2Head(key).catch(() => ({ exists: false, size: 0 }));
      if (head.exists && head.size === s.size) {
        skipped++;
        continue;
      }
      if (!apply) {
        // dry-run: would copy
        copied++;
        continue;
      }
      const bytes = await readFile(full);
      const ext = path.extname(rel).toLowerCase();
      await r2Put(key, bytes, MIME_BY_EXT[ext] || "application/octet-stream");
      // Verify it landed with the right size.
      const verify = await r2Head(key);
      if (!verify.exists || verify.size !== s.size) {
        failed.push({ path: rel, error: `verify mismatch (got ${verify.size}, expected ${s.size})` });
        continue;
      }
      copied++;
    } catch (e) {
      failed.push({ path: rel, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const nextIdx = startIdx + batch.length;
  const done = nextIdx >= all.length;

  return NextResponse.json({
    type,
    apply,
    scanned: all.length,
    batch: batch.length,
    copied,
    skipped,
    failed,
    nextCursor: done ? null : batch[batch.length - 1] ?? null,
    done,
    hint: apply
      ? done
        ? "Migration complete for this type. Volume files are untouched — delete them only after verifying."
        : "Batch copied. Call again with ?apply=1&cursor=<nextCursor> to continue."
      : "Dry run — 'copied' is how many WOULD copy. Add &apply=1 to actually copy.",
  });
}
